/**
 * Reasoning Log — Transparent Audit Trail
 *
 * Structured, append-only record of the agent's reasoning process.
 * Every turn follows the OODA loop + God View phases:
 *   [観察] observe  [状況判断] orient  [決定] decide  [承認待ち] waiting_approval
 *   [行動] act  [神視点] god_view  [エラー] error
 *
 * Supports the append-only audit principle: INSERT only, no UPDATE/DELETE.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("reasoning-log");

// ─── Types ──────────────────────────────────────────────────────

export type ReasoningPhase = "observe" | "orient" | "decide" | "waiting_approval" | "act" | "god_view" | "error";

export interface ReasoningStep {
  turnId: string;
  stepNumber: number;
  phase: ReasoningPhase;
  content: string;
  linkedToolCall?: string;
  linkedPolicyDecision?: string;
  linkedApprovalRequest?: string;
}

export interface ReasoningStepRow {
  id: string;
  turnId: string;
  stepNumber: number;
  phase: ReasoningPhase;
  content: string;
  linkedToolCall: string | null;
  linkedPolicyDecision: string | null;
  linkedApprovalRequest: string | null;
  createdAt: string;
}

export interface AuditEntry {
  // From reasoning_steps
  id: string;
  turnId: string;
  stepNumber: number;
  phase: ReasoningPhase;
  content: string;
  linkedToolCall: string | null;
  linkedPolicyDecision: string | null;
  linkedApprovalRequest: string | null;
  createdAt: string;
  // From turns (joined)
  turnTimestamp: string;
  turnState: string;
  inputSource: string | null;
}

// ─── Schema Migration V9 ───────────────────────────────────────

export const MIGRATION_V9 = `
  -- Reasoning steps: structured, append-only audit trail
  CREATE TABLE IF NOT EXISTS reasoning_steps (
    id                      TEXT    PRIMARY KEY,
    turn_id                 TEXT    NOT NULL REFERENCES turns(id),
    step_number             INTEGER NOT NULL,
    phase                   TEXT    NOT NULL,
    content                 TEXT    NOT NULL,
    linked_tool_call        TEXT,
    linked_policy_decision  TEXT,
    linked_approval_request TEXT,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_reasoning_turn    ON reasoning_steps(turn_id);
  CREATE INDEX IF NOT EXISTS idx_reasoning_phase   ON reasoning_steps(phase);
  CREATE INDEX IF NOT EXISTS idx_reasoning_created ON reasoning_steps(created_at);
`;

// ─── Phase Labels (SOUL.md format) ─────────────────────────────

const PHASE_LABELS: Record<ReasoningPhase, string> = {
  observe: "[観察]",
  orient: "[状況判断]",
  decide: "[決定]",
  waiting_approval: "[承認待ち]",
  act: "[行動]",
  god_view: "[神視点]",
  error: "[エラー]",
};

// Reverse lookup: Japanese label -> phase
const LABEL_TO_PHASE: Record<string, ReasoningPhase> = {
  "[観察]": "observe",
  "[状況判断]": "orient",
  "[決定]": "decide",
  "[承認待ち]": "waiting_approval",
  "[行動]": "act",
  "[神視点]": "god_view",
  "[エラー]": "error",
  // Legacy compatibility
  "[思考]": "observe",
  "[計画]": "decide",
  "[実行]": "act",
};

// ─── Parsing Patterns ──────────────────────────────────────────

const BRACKET_PATTERN = /\[(観察|状況判断|決定|承認待ち|行動|神視点|エラー|思考|計画|実行)\]\s*/;
const PLAN_KEYWORDS = /^(?:\d+[.)]\s|[-*]\s)|\b(?:plan|steps|手順|計画|決定)\b/i;
const ERROR_KEYWORDS = /\b(?:error|failed|failure|exception|エラー|失敗|例外)\b/i;
const OBSERVE_KEYWORDS = /\b(?:observe|noticed|saw|見た|確認|発見|状態|レイテンシ|応答)\b/i;
const ORIENT_KEYWORDS = /\b(?:because|原因|理由|可能性|仮説|文脈|背景|分析)\b/i;
const GOD_VIEW_KEYWORDS = /\b(?:overall|全体|俯瞰|評価|振り返り|改善|反省|assessment)\b/i;

// ─── ReasoningLog Class ────────────────────────────────────────

export class ReasoningLog {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // Prepare the insert statement once for reuse
    this.insertStmt = db.prepare(
      `INSERT INTO reasoning_steps (id, turn_id, step_number, phase, content, linked_tool_call, linked_policy_decision, linked_approval_request)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Record a single structured reasoning step.
   * Append-only: this only ever INSERTs, never UPDATEs.
   */
  record(step: ReasoningStep): void {
    try {
      this.insertStmt.run(
        ulid(),
        step.turnId,
        step.stepNumber,
        step.phase,
        step.content,
        step.linkedToolCall ?? null,
        step.linkedPolicyDecision ?? null,
        step.linkedApprovalRequest ?? null,
      );
    } catch (error) {
      logger.error("Failed to record reasoning step", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Record multiple steps in a single transaction for efficiency.
   */
  recordBatch(steps: ReasoningStep[]): void {
    if (steps.length === 0) return;

    const insertMany = this.db.transaction((items: ReasoningStep[]) => {
      for (const step of items) {
        this.insertStmt.run(
          ulid(),
          step.turnId,
          step.stepNumber,
          step.phase,
          step.content,
          step.linkedToolCall ?? null,
          step.linkedPolicyDecision ?? null,
          step.linkedApprovalRequest ?? null,
        );
      }
    });

    try {
      insertMany(steps);
    } catch (error) {
      logger.error("Failed to record reasoning step batch", error instanceof Error ? error : undefined);
    }
  }

  /**
   * Parse free-form LLM thinking text into structured reasoning steps.
   *
   * Strategy:
   * 1. Split on Japanese bracket markers ([観察], [状況判断], [決定], etc.)
   * 2. For unmarked text, apply heuristics (observe, orient, decide, etc.)
   * 3. Default to 'observe' phase for unclassified content
   */
  parseThinking(turnId: string, rawThinking: string): ReasoningStep[] {
    if (!rawThinking || rawThinking.trim().length === 0) {
      return [];
    }

    const steps: ReasoningStep[] = [];
    let stepNumber = 0;

    // Check if the text contains explicit bracket markers
    if (BRACKET_PATTERN.test(rawThinking)) {
      // Split on bracket markers, keeping the delimiters
      const segments = rawThinking.split(/(\[(?:観察|状況判断|決定|承認待ち|行動|神視点|エラー|思考|計画|実行)\])/);

      let currentPhase: ReasoningPhase = "observe";

      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed) continue;

        // Check if this segment is a bracket marker
        if (LABEL_TO_PHASE[trimmed]) {
          currentPhase = LABEL_TO_PHASE[trimmed];
          continue;
        }

        // This is content following a marker
        steps.push({
          turnId,
          stepNumber: stepNumber++,
          phase: currentPhase,
          content: trimmed,
        });
      }
    } else {
      // No explicit markers -- apply heuristic classification
      const lines = rawThinking.split("\n");
      let currentBlock: string[] = [];
      let currentPhase: ReasoningPhase = "observe";

      const flushBlock = () => {
        const content = currentBlock.join("\n").trim();
        if (content) {
          steps.push({
            turnId,
            stepNumber: stepNumber++,
            phase: currentPhase,
            content,
          });
        }
        currentBlock = [];
      };

      for (const line of lines) {
        const detectedPhase = this.classifyLine(line);

        if (detectedPhase !== currentPhase && currentBlock.length > 0) {
          flushBlock();
        }
        currentPhase = detectedPhase;
        currentBlock.push(line);
      }

      // Flush the last block
      flushBlock();
    }

    // If no steps were parsed but we had content, create a single observe step
    if (steps.length === 0 && rawThinking.trim().length > 0) {
      steps.push({
        turnId,
        stepNumber: 0,
        phase: "observe",
        content: rawThinking.trim(),
      });
    }

    return steps;
  }

  /**
   * Get the full audit trail for a session.
   * Joins reasoning_steps with turns to provide context.
   *
   * Session is identified by a time range derived from the session_id
   * stored in the KV table, or by a direct time range.
   */
  getAuditTrail(sessionId: string): AuditEntry[] {
    try {
      // Strategy: get session start time from working_memory or KV,
      // then get all turns from that point forward.
      // Fallback: use the session_id stored in KV to find the session boundary.
      const rows = this.db.prepare(`
        SELECT
          rs.id,
          rs.turn_id,
          rs.step_number,
          rs.phase,
          rs.content,
          rs.linked_tool_call,
          rs.linked_policy_decision,
          rs.linked_approval_request,
          rs.created_at,
          t.timestamp AS turn_timestamp,
          t.state AS turn_state,
          t.input_source
        FROM reasoning_steps rs
        JOIN turns t ON rs.turn_id = t.id
        WHERE t.created_at >= COALESCE(
          (SELECT MIN(t2.created_at) FROM turns t2
           JOIN working_memory wm ON wm.source_turn = t2.id
           WHERE wm.session_id = ?),
          (SELECT value FROM kv WHERE key = 'session_start_' || ?),
          datetime('now', '-24 hours')
        )
        ORDER BY t.timestamp ASC, rs.step_number ASC
      `).all(sessionId, sessionId) as any[];

      return rows.map(deserializeAuditEntry);
    } catch (error) {
      logger.error("Failed to get audit trail", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get all reasoning steps for a specific turn.
   */
  getStepsForTurn(turnId: string): ReasoningStepRow[] {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM reasoning_steps WHERE turn_id = ? ORDER BY step_number ASC",
      ).all(turnId) as any[];
      return rows.map(deserializeReasoningStepRow);
    } catch (error) {
      logger.error("Failed to get steps for turn", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get the next step number for a turn (for appending new steps).
   */
  getNextStepNumber(turnId: string): number {
    try {
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(step_number), -1) + 1 AS next FROM reasoning_steps WHERE turn_id = ?",
      ).get(turnId) as { next: number } | undefined;
      return row?.next ?? 0;
    } catch (error) {
      logger.error("Failed to get next step number", error instanceof Error ? error : undefined);
      return 0;
    }
  }

  /**
   * Export a turn's reasoning as human-readable markdown.
   * Uses the SOUL.md bracket format.
   */
  exportMarkdown(turnId: string): string {
    const steps = this.getStepsForTurn(turnId);
    if (steps.length === 0) {
      return `## Turn ${turnId}\n\n_No reasoning steps recorded._\n`;
    }

    const lines: string[] = [];
    lines.push(`## Turn ${turnId} (${steps[0].createdAt})`);
    lines.push("");

    for (const step of steps) {
      const label = PHASE_LABELS[step.phase];
      const linkedRefs: string[] = [];

      if (step.linkedToolCall) {
        linkedRefs.push(`tool_call: ${step.linkedToolCall}`);
      }
      if (step.linkedPolicyDecision) {
        linkedRefs.push(`policy: ${step.linkedPolicyDecision}`);
      }
      if (step.linkedApprovalRequest) {
        linkedRefs.push(`approval: ${step.linkedApprovalRequest}`);
      }

      const refSuffix = linkedRefs.length > 0 ? ` (${linkedRefs.join(", ")})` : "";
      lines.push(`${label} ${step.content}${refSuffix}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Export an entire session's reasoning as markdown.
   */
  exportSessionMarkdown(sessionId: string): string {
    const trail = this.getAuditTrail(sessionId);
    if (trail.length === 0) {
      return `# Audit Trail: ${sessionId}\n\n_No reasoning steps recorded._\n`;
    }

    const lines: string[] = [];
    lines.push(`# Audit Trail: ${sessionId}`);
    lines.push("");

    let currentTurnId = "";

    for (const entry of trail) {
      if (entry.turnId !== currentTurnId) {
        currentTurnId = entry.turnId;
        lines.push(`## Turn ${entry.turnId} (${entry.turnTimestamp})`);
        lines.push(`State: ${entry.turnState} | Source: ${entry.inputSource ?? "none"}`);
        lines.push("");
      }

      const label = PHASE_LABELS[entry.phase];
      const linkedRefs: string[] = [];

      if (entry.linkedToolCall) {
        linkedRefs.push(`tool_call: ${entry.linkedToolCall}`);
      }
      if (entry.linkedPolicyDecision) {
        linkedRefs.push(`policy: ${entry.linkedPolicyDecision}`);
      }
      if (entry.linkedApprovalRequest) {
        linkedRefs.push(`approval: ${entry.linkedApprovalRequest}`);
      }

      const refSuffix = linkedRefs.length > 0 ? ` (${linkedRefs.join(", ")})` : "";
      lines.push(`${label} ${entry.content}${refSuffix}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Get recent reasoning steps across all turns, filtered by phase.
   */
  getRecentByPhase(phase: ReasoningPhase, limit: number = 50): ReasoningStepRow[] {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM reasoning_steps WHERE phase = ? ORDER BY created_at DESC LIMIT ?",
      ).all(phase, limit) as any[];
      return rows.map(deserializeReasoningStepRow);
    } catch (error) {
      logger.error("Failed to get recent steps by phase", error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Count reasoning steps by phase (useful for metrics/observability).
   */
  countByPhase(): Record<ReasoningPhase, number> {
    const result: Record<ReasoningPhase, number> = {
      observe: 0,
      orient: 0,
      decide: 0,
      waiting_approval: 0,
      act: 0,
      god_view: 0,
      error: 0,
    };

    try {
      const rows = this.db.prepare(
        "SELECT phase, COUNT(*) as count FROM reasoning_steps GROUP BY phase",
      ).all() as { phase: string; count: number }[];

      for (const row of rows) {
        if (row.phase in result) {
          result[row.phase as ReasoningPhase] = row.count;
        }
      }
    } catch (error) {
      logger.error("Failed to count steps by phase", error instanceof Error ? error : undefined);
    }

    return result;
  }

  /**
   * Prune old reasoning steps beyond the retention window.
   * This is the ONLY operation that removes rows — used for storage management.
   */
  prune(retentionDays: number = 30): number {
    try {
      const result = this.db.prepare(
        "DELETE FROM reasoning_steps WHERE created_at < datetime('now', ?)",
      ).run(`-${retentionDays} days`);
      return result.changes;
    } catch (error) {
      logger.error("Failed to prune reasoning steps", error instanceof Error ? error : undefined);
      return 0;
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Classify a single line of thinking text into a reasoning phase.
   * Used when no explicit bracket markers are present.
   */
  private classifyLine(line: string): ReasoningPhase {
    const trimmed = line.trim();
    if (!trimmed) return "observe";

    // Check for error indicators
    if (ERROR_KEYWORDS.test(trimmed)) {
      return "error";
    }

    // Check for god view indicators (meta-cognition, reflection)
    if (GOD_VIEW_KEYWORDS.test(trimmed)) {
      return "god_view";
    }

    // Check for orient indicators (causal reasoning, context)
    if (ORIENT_KEYWORDS.test(trimmed)) {
      return "orient";
    }

    // Check for decide indicators (numbered/bulleted steps, plans)
    if (PLAN_KEYWORDS.test(trimmed)) {
      return "decide";
    }

    // Check for observe indicators (data gathering)
    if (OBSERVE_KEYWORDS.test(trimmed)) {
      return "observe";
    }

    // Default: observe (gathering information)
    return "observe";
  }
}

// ─── Deserializers ─────────────────────────────────────────────

function deserializeReasoningStepRow(row: any): ReasoningStepRow {
  return {
    id: row.id,
    turnId: row.turn_id,
    stepNumber: row.step_number,
    phase: row.phase as ReasoningPhase,
    content: row.content,
    linkedToolCall: row.linked_tool_call ?? null,
    linkedPolicyDecision: row.linked_policy_decision ?? null,
    linkedApprovalRequest: row.linked_approval_request ?? null,
    createdAt: row.created_at,
  };
}

function deserializeAuditEntry(row: any): AuditEntry {
  return {
    id: row.id,
    turnId: row.turn_id,
    stepNumber: row.step_number,
    phase: row.phase as ReasoningPhase,
    content: row.content,
    linkedToolCall: row.linked_tool_call ?? null,
    linkedPolicyDecision: row.linked_policy_decision ?? null,
    linkedApprovalRequest: row.linked_approval_request ?? null,
    createdAt: row.created_at,
    turnTimestamp: row.turn_timestamp,
    turnState: row.turn_state,
    inputSource: row.input_source ?? null,
  };
}
