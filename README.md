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
don't), a **triviality check** that talks you out of a 4-agent team for a typo fix, semantic
feedback rules that keep the developer from reverse-engineering assertions, an ownership map
that makes file races impossible by construction rather than by luck, and an **isolation guard**
hook that enforces the tester/developer split in the harness instead of only asking for it.

## Install

Needs Claude Code **2.1.295 or later** (earlier builds fail a teammate's first `SendMessage` until it loads the tool through
`ToolSearch`) and
agent teams switched on: `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` in your settings `env`.
Teams need an interactive session — they don't run under `-p` or the Agent SDK.

Two equal ways in; pick one.

**From the marketplace.**

```
claude plugin install team-swarm --marketplace jokius/team-swarm
```

(or, inside a session, `/plugin marketplace add jokius/team-swarm` then
`/plugin install team-swarm@team-swarm`). Marketplace skills are namespaced, so this one is
`team-swarm:team-swarm`.

**Into your skills folder** — clone it, or symlink a checkout you edit:

```
git clone https://github.com/jokius/team-swarm ~/.claude/skills/team-swarm
# or: ln -s /path/to/team-swarm ~/.claude/skills/team-swarm
```

Use `$CLAUDE_CONFIG_DIR/skills/` if you set `CLAUDE_CONFIG_DIR`. The folder carries its plugin
manifest, so the next session loads it as `team-swarm@skills-dir` — skill and hooks — under the
bare name `team-swarm`.

Keep one copy, not both: an installed marketplace plugin takes precedence and the skills-dir
plugin shows up as "Not loaded" with its hooks off, yet its `SKILL.md` still loads as a plain
`team-swarm` skill next to the marketplace `team-swarm:team-swarm` — two copies, possibly of
different versions.

Then run `/team-swarm install` (`/team-swarm:team-swarm install` for a marketplace install) — it
checks the environment (Claude Code version, the agent-teams flag, Workflow switches, node,
recommended plugins, tool availability) and offers to fix what's missing.

Recommended companions, all optional: `compound-engineering` (specialised review agents) and
[`impeccable`](https://github.com/pbakaus/impeccable) (design pass on frontend work).

[`superpowers`](https://github.com/obra/superpowers-marketplace) is a fallback, not a requirement: TDD here
is enforced by structure (tester/developer isolation, the guard hook and the lead's RED→GREEN gate), not
by a plugin. If it is installed, the tester uses its `test-driven-development` skill for RED discipline;
without it nothing is lost.

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
commands, an explicit "solo", agent messages and task notifications, and once the skill has run
in the session.

Enable it with the plugin option `nudge=smart`:

```
# at install time
claude plugin install team-swarm --marketplace jokius/team-swarm --config nudge=smart
# or later — team-swarm@team-swarm for a marketplace install, team-swarm@skills-dir for the skills folder
printf '{"nudge":"smart"}' | claude plugin configure team-swarm@skills-dir --values-stdin
```

Or set `TEAM_SWARM_NUDGE=smart` in your settings `env` (works for either install and wins over
the plugin option). `always` nudges on every prompt you type; `off` disables. Takes effect after
a session restart.

## The isolation guard

Always on whenever team-swarm is loaded as a plugin (marketplace or skills folder); a plain skill
folder without `.claude-plugin/` loads no hooks. A `PreToolUse` hook that acts only on teammates
named `tester-*`, `developer-*` or `worker-*` — inside a teammate, the hook's `agent_type` is the
teammate's name (verified on 2.1.296, not documented, so it may change):

- none of them may spawn subagents or call `TaskStop` — a child outlives its parent's stop and is a
  side door around the read bans;
- `tester-*` / `developer-*` may not touch the paths the lead lists for their role in
  `.team-swarm/isolation.json` (e.g. `{"tester": ["src/"], "developer": ["tests/"]}`): file tools
  on those paths, searches whose scope covers them, and Bash commands that name them. In Bash a
  recursive search (`rg`, `grep -r`, `find`, `git grep`, `tree`) or a content-printing git command
  (`git diff`, `git show`, `git log -p`) must name the teammate's own directories with a trailing
  slash (`rg foo src/`; for git, after `--`); without one it would cover the whole project, so it
  is refused with a hint to re-run it scoped. With a suffix ban such as `*_test.go` (tests next to
  the code) any directory search is refused and the teammate searches by file name.

Paths are compared in canonical form (a symlink such as `t -> tests`, or `Tests/` on a
case-insensitive disk, doesn't get through), and these teammates may not change the
`.team-swarm/` map or the guard's own files.

With a map in place these teammates also get file, shell, search and messaging tools only
(`Monitor`, `LSP`, `Artifact` or an MCP file reader would sidestep the map); anything else goes
into `"allowTools"` in the map, e.g. `["mcp__plugin_playwright_playwright__*"]`.

Threat model: accidental leaks and casual drift by cooperative agents — not an agent that sets
out to beat the guard. Bash is a general-purpose language, so variables (`d=tests; cat $d/x`),
an interpreter with built strings, `npm test` output or `cd tests && cat *` get through any
string check; a hard boundary would take a worktree without the other side's files. The briefs
and the review keep the same rules. Everywhere else it costs one `sh` start (~6 ms) per tool call.

## Layout

```
SKILL.md              entry point: preflight gate, mode choice, lifecycle
install.md            /team-swarm install runbook
role-briefs.md        spawn prompts for every role (English)
tdd-cycle.md          mode A runbook: semantic feedback, isolation smells
fanout-workflow.md    mode B on the Workflow backend
swarm-primitives.md   agent-teams API cheat sheet
hooks/                nudge hook (optional) and isolation guard (always on), with tests
scripts/doctor.mjs    environment check used by /team-swarm install
```

Tests: `node hooks/swarm-nudge.test.mjs && node hooks/isolation-guard.test.mjs`.

## License

MIT
