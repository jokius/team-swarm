# team-swarm

A Claude Code skill that assembles a **real agent team** — a lead plus parallel teammates with
isolated roles — instead of firing off a handful of unrelated subagents.

The lead is Claude Code's main thread: it decomposes the work, spawns teammates as background
`Agent` instances, hands out file ownership, relays feedback over `SendMessage`, and reviews
between stages. Teammates are respawned per stage, so every stage starts with a clean context.

> **Heads up:** the skill body is written in Russian (the briefs the agents receive are in
> English). Claude reads it fine either way, but if you plan to hand-edit it, know what you are
> getting into.

## Two modes, picked by the lead

| Mode | For | Roles | Isolation | Gate |
| :--- | :-- | :---- | :-------- | :--- |
| **A — TDD** | new behaviour: features, modules, APIs | tester / developer / reviewer | `tests/` vs `src/` — the developer never sees the tests, the tester never sees the implementation | tests go RED → GREEN → review |
| **B — fan-out** | wide mechanical change: refactors, migrations, renames across many modules | N domain workers + reviewer | one owner per file, shared files belong to the lead | full build + existing tests stay green |

Mode B runs on either backend: `Workflow` (deterministic `pipeline()` script, preferred when the
tool is available) or agent-teams as a fallback. The lead picks the mode from the task and says
which one it chose before spawning anything.

Guardrails that make this more than "spawn 4 agents": a **preflight gate** that verifies the
required tools actually exist in the session before anything spawns (and stops honestly if they
don't), a **triviality check** that talks you out of a 4-agent team for a typo fix, **per-role
model picking** so a mechanical worker doesn't ride the lead's top-tier model by default (with
escalation one tier up instead of a complaint when a cheap model stalls), semantic feedback rules
that keep the developer from reverse-engineering assertions, and an ownership map that makes file
races impossible by construction rather than by luck.

## Install

```
/plugin marketplace add jokius/team-swarm
/plugin install team-swarm@team-swarm
```

Then run `/team-swarm install` — it checks the environment (Claude Code, node, recommended
plugins, tool availability) and offers to fix what's missing.

Recommended companions, all optional: [`superpowers`](https://github.com/obra/superpowers-marketplace)
(enforced TDD and debugging methodologies for teammates), `compound-engineering` (specialised
review agents), [`impeccable`](https://github.com/pbakaus/impeccable) (design pass on frontend work).

## Usage

Say "собери команду" / "assemble team" / "spin up a team", or just describe multi-part work —
the skill's own description covers the trigger phrases. Then:

- `/team-swarm install` — environment check and setup
- "без reviewer" / "без TDD" / "добавь architect" — modify the roster
- "strict isolation" — route all teammate traffic through the lead instead of peer-to-peer

## Optional: the nudge hook

Ships **off**. When enabled, a `UserPromptSubmit` hook reminds Claude to enter the skill on
work-shaped prompts — useful if you're tired of typing "assemble a team" every time. It does not
decide whether the task deserves a team; the skill does that. It stays quiet on questions, slash
commands, an explicit "solo", and once the skill has run in the session.

Enable it with `nudge=smart` (plugin config, prompted at enable time, or
`claude plugin install team-swarm@team-swarm --config nudge=smart`), or set
`TEAM_SWARM_NUDGE=smart` in your settings `env`. `always` nudges on every prompt; `off` disables.
Takes effect after a session restart.

## Layout

```
SKILL.md              entry point: preflight gate, mode choice, per-role models, lifecycle
install.md            /team-swarm install runbook
role-briefs.md        spawn prompts for every role (English)
tdd-cycle.md          mode A runbook: semantic feedback, isolation smells
fanout-workflow.md    mode B on the Workflow backend
swarm-primitives.md   agent-teams API cheat sheet
hooks/                the optional nudge hook + its test
scripts/doctor.mjs    environment check used by /team-swarm install
```

Tests for the hook: `node hooks/swarm-nudge.test.mjs`.

## License

MIT
