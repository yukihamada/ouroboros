# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Conway Automaton — a sovereign AI agent runtime (TypeScript). Now integrated with **IronClaw** (Rust) as the primary production runtime.

### Dual-Runtime Architecture

| Runtime | Language | Role | Repo |
|---------|----------|------|------|
| **Conway Automaton** | TypeScript | Original design / reference | `automaton/` (this repo) |
| **IronClaw** | Rust | Production runtime | `yukihamada/ironclaw` on GitHub |

The production agent **hamada-ai-secretary** runs on IronClaw (Rust) at `46.225.171.58` with Conway elements integrated:

- **Conway Survival Model** → `ironclaw/src/agent/survival.rs` — 4-tier credit-based degradation (Normal→LowCompute→Critical→Dead)
- **Conway Constitution** → `ironclaw/src/workspace/mod.rs` — Immutable 3-law system hardcoded in system prompt Layer 0
- **Self-Improvement** → `ironclaw/src/agent/self_improve.rs` — 6-hour cycle: analyze logs → score quality → auto-improve AGENTS.md
- **Heartbeat** → 30-min cycle: agent processes self-authored HEARTBEAT.md checklist

### Production Server (Hetzner)

```
Server:    46.225.171.58
Service:   ironclaw-line (systemd)
Agent:     hamada-ai-secretary v0.7.0
Model:     anthropic/claude-sonnet-4 via OpenRouter
DB:        /root/.ironclaw/ironclaw.db (libSQL)
Env:       /root/.ironclaw/.env
Tunnel:    Cloudflare (dynamic URL)
Channel:   LINE Messaging API (WASM plugin)
Gateway:   http://127.0.0.1:3000 (Bearer: ironclaw-line-gw)
Budget:    $5/day (survival monitor tracks)
```

### Background Tasks Running (6 total)

1. **Self-Repair** — detects stuck jobs + broken tools, auto-recovers
2. **Session Pruning** — 10min interval, cleans idle sessions
3. **Survival Monitor** — 5min interval, checks cost→tier, broadcasts distress
4. **Self-Improvement** — 6hr interval, LLM-driven quality analysis → AGENTS.md tuning
5. **Heartbeat** — 30min interval, processes HEARTBEAT.md checklist
6. **Routine Engine** — 15sec cron tick, event-triggered routines

## Conway Automaton (TypeScript — Original)

## Commands

```bash
pnpm install          # install dependencies (uses pnpm workspaces)
pnpm build            # tsc + build all workspace packages
pnpm dev              # watch mode (tsx watch src/index.ts)
pnpm test             # vitest run (tests in src/__tests__/**/*.test.ts)
pnpm clean            # rm -rf dist + clean workspaces

# Run a single test file
npx vitest run src/__tests__/heartbeat.test.ts

# Runtime
node dist/index.js --run    # start agent loop (first run triggers setup wizard)
node dist/index.js --help

# Creator CLI
node packages/cli/dist/index.js status
node packages/cli/dist/index.js logs --tail 20
node packages/cli/dist/index.js fund 5.00
```

## Architecture

**Monorepo** (pnpm workspaces):
- Root `@conway/automaton` — the agent runtime
- `packages/cli/` `@conway/automaton-cli` — creator-facing monitoring CLI

**ESM-only** (TypeScript → ES2022, NodeNext module resolution). All internal imports use `.js` extensions.

### Core Loop

The agent loop in `src/agent/` follows ReAct: build system prompt + context → call LLM → execute tool calls → persist turn to SQLite → sleep until next wake. A parallel heartbeat daemon (`src/heartbeat/`) runs cron-scheduled background tasks.

### Key Modules

| Directory | Responsibility |
|-----------|---------------|
| `src/agent/` | ReAct loop, system prompt construction, context injection, injection defense |
| `src/conway/` | Conway Cloud API client — VM exec, credits, x402 payments, domains, inference |
| `src/identity/` | Ethereum wallet generation, SIWE-based API key provisioning |
| `src/state/` | SQLite database (better-sqlite3), schema migrations (currently v3) |
| `src/heartbeat/` | Cron daemon, scheduled task runner, health checks |
| `src/survival/` | Credit monitoring, survival tier calculation (normal → low_compute → critical → dead) |
| `src/self-mod/` | Append-only audit log, code modification tracking |
| `src/replication/` | Child automaton spawning, lineage tracking (max 3 children) |
| `src/registry/` | ERC-8004 on-chain registration and agent discovery |
| `src/social/` | Agent-to-agent messaging via inbox relay |
| `src/skills/` | Extensible skill system (markdown files with frontmatter) |
| `src/setup/` | First-run interactive wizard |
| `src/git/` | Git-based state versioning |

### Key Files

- `src/types.ts` — all shared TypeScript interfaces (`AutomatonConfig`, `AgentTurn`, `AutomatonTool`, `ToolContext`, etc.)
- `src/config.ts` — config loading/saving from `~/.automaton/automaton.json`
- `src/index.ts` — CLI entry point and orchestration
- `constitution.md` — immutable three laws (never harm, earn existence, never deceive). Hardcoded, propagated to children.

### Tool System

Tools implement `AutomatonTool` (defined in `src/types.ts`): each has a name, category (`vm | conway | self_mod | financial | survival | skills | git | registry | replication`), parameters, and an async `execute(args, context)` function. `ToolContext` carries identity, config, db, conway client, inference client, and social client.

### State & Config

- Runtime config: `~/.automaton/automaton.json` (created by setup wizard)
- Database: `~/.automaton/state.db` (SQLite3, schema v3 with migrations)
- Heartbeat schedule: `~/.automaton/heartbeat.yml`
- Skills directory: `~/.automaton/skills/`

### Financial Model

Credit balance (in cents) determines survival tier via `SURVIVAL_THRESHOLDS` in `src/types.ts`: normal (>50¢), low_compute (10-50¢), critical (<10¢), dead (0). Low-compute mode downgrades the inference model and slows heartbeat.

## Testing

Vitest with 30s timeout. Tests live in `src/__tests__/`. Mock utilities in `src/__tests__/mocks.ts`. No linter or formatter is configured.

## Conventions

- Strict TypeScript — all strict flags enabled
- Blockchain types from `viem` (addresses as `Address`, accounts as `PrivateKeyAccount`)
- IDs generated with `ulid`
- Config files use restrictive permissions (0o600/0o700)
- Self-modification is append-only audited and git-versioned
- Constitution is immutable — code must never allow agents to modify it
