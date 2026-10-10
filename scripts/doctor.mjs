#!/usr/bin/env node
// team-swarm doctor — checks the environment AROUND the skill.
// Run: node scripts/doctor.mjs
//
// It reads the on-disk switches (agent-teams flag, workflow kill switches, version)
// but does NOT check whether Agent / SendMessage / Workflow are actually in the tool
// list: that lives in the session, so only the model can see it. The skill's own
// Preflight gate covers it (SKILL.md → "Требования среды и Preflight-гейт").
//
// Output is one line per check: STATUS  name  detail
// STATUS is OK | WARN | MISS | OFF | UNKNOWN. A "fix:" is either a command that is
// safe to run as-is or a pointer to the install.md step.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGINS = [
  {
    id: 'superpowers',
    why: 'enforced TDD / debugging methodologies for teammates (strongly recommended)',
    fix: 'claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers-marketplace',
  },
  {
    id: 'compound-engineering',
    why: 'specialised review agents for the reviewer role (optional)',
    fix: 'claude plugin marketplace add EveryInc/compound-engineering-plugin && claude plugin install compound-engineering@compound-engineering-plugin',
  },
  {
    id: 'impeccable',
    why: 'design pass on frontend tasks (optional)',
    fix: 'claude plugin marketplace add pbakaus/impeccable && claude plugin install impeccable@impeccable',
  },
]

const rows = []
const add = (status, name, detail) => rows.push([status, name, detail])

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const settingsPath = join(configDir, 'settings.json')
let settings = {}
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
} catch {
  settings = {}
}

const OFF = new Set(['', 'off', 'false', '0', 'no'])
const isOn = (value) => !OFF.has(String(value ?? '').trim().toLowerCase())
// A flag counts when it is set in this process or in the config dir's settings `env`.
const flagSource = (key) =>
  isOn(process.env[key]) ? 'this process' : isOn(settings.env?.[key]) ? `env in ${settingsPath}` : null

// 1. Claude Code itself. 2.1.295 fixed teammates failing their first SendMessage
// (2.1.288 before it: plugin agents spawned by name keep their own prompt and tools).
const MIN_VERSION = [2, 1, 295]
const versionText = run('claude', ['--version'])
const version = versionText?.match(/(\d+)\.(\d+)\.(\d+)/)
if (!version) {
  add('UNKNOWN', 'claude', 'CLI not on PATH — checks below may be incomplete')
} else {
  const parts = version.slice(1).map(Number)
  const diff = parts.map((n, i) => n - MIN_VERSION[i]).find((d) => d !== 0) ?? 0
  if (diff >= 0) add('OK', 'claude', version[0])
  else
    add(
      'WARN',
      'claude',
      `${version[0]} is older than ${MIN_VERSION.join('.')}: teammates' first SendMessage fails there until they load it via ToolSearch — fix: claude update`,
    )
}

// 2. Agent teams. Without the flag Agent has no `name` parameter and every spawn is a
// plain subagent, so mode A (TDD) is impossible.
const teams = flagSource('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS')
if (teams) add('OK', 'agent-teams', `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS (${teams})`)
else
  add(
    'OFF',
    'agent-teams',
    `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS not set — mode A (TDD) impossible — fix: install.md → «Agent teams»`,
  )

// 3. Workflow kill switches. Not disabled ≠ available: Preflight checks the tool itself.
const workflowSwitch = flagSource('CLAUDE_CODE_DISABLE_WORKFLOWS')
const workflowsOff =
  settings.disableWorkflows === true
    ? `disableWorkflows in ${settingsPath}`
    : workflowSwitch && `CLAUDE_CODE_DISABLE_WORKFLOWS, ${workflowSwitch}`
if (workflowsOff) add('OFF', 'workflow', `disabled (${workflowsOff}) — mode B runs on agent-teams instead`)
else add('OK', 'workflow', 'not disabled in env or settings')

// 4. node — the nudge hook runs on it
add('OK', 'node', process.version)

// 5. Recommended plugins
const pluginList = run('claude', ['plugin', 'list'])
for (const plugin of PLUGINS) {
  if (pluginList === null) {
    add('UNKNOWN', `plugin:${plugin.id}`, `could not run "claude plugin list" — check manually. ${plugin.why}`)
  } else if (new RegExp(`\\b${plugin.id}@`).test(pluginList)) {
    add('OK', `plugin:${plugin.id}`, plugin.why)
  } else {
    add('MISS', `plugin:${plugin.id}`, `${plugin.why} — fix: ${plugin.fix}`)
  }
}

// 6. How team-swarm itself is loaded. Two copies = a marketplace install shadowing the
// skills-dir one: the installed plugin takes precedence, the skills-dir copy is not loaded.
const ids = [...new Set(pluginList?.match(/\bteam-swarm@[\w-]+/g) ?? [])]
if (ids.length > 1) {
  add('WARN', 'skill:team-swarm', `several copies (${ids.join(', ')}) — the marketplace install wins and the skills-dir hooks are off, but its SKILL.md still loads as a plain team-swarm next to team-swarm:team-swarm; remove one`)
} else if (ids.length === 1) {
  add('OK', 'skill:team-swarm', `loaded as plugin ${ids[0]}`)
} else if (existsSync(join(configDir, 'skills', 'team-swarm', 'SKILL.md'))) {
  add('OK', 'skill:team-swarm', `plain skill at ${join(configDir, 'skills', 'team-swarm')} (hooks — nudge and isolation guard — need the plugin manifest; restart the session)`)
} else {
  add('MISS', 'skill:team-swarm', 'not found in this config dir — is CLAUDE_CONFIG_DIR pointing somewhere else?')
}

// 7. Nudge hook state. Env wins over the plugin's userConfig, same as in the hook.
const envMode = (process.env.TEAM_SWARM_NUDGE || '').trim().toLowerCase()
const settingsMode = String(settings.env?.TEAM_SWARM_NUDGE ?? '').trim().toLowerCase()
const configuredNudge = Object.entries(settings.pluginConfigs ?? {})
  .filter(([id]) => id.startsWith('team-swarm@'))
  .map(([, value]) => value?.options?.nudge)
  .find((value) => value !== undefined)

if (envMode && !OFF.has(envMode)) add('OK', 'hook:nudge', `${envMode} (TEAM_SWARM_NUDGE in this process)`)
else if (settingsMode && !OFF.has(settingsMode)) add('OK', 'hook:nudge', `${settingsMode} (env in ${settingsPath})`)
else if (configuredNudge !== undefined && !OFF.has(String(configuredNudge).toLowerCase()))
  add('OK', 'hook:nudge', `${configuredNudge} (plugin userConfig)`)
else add('OFF', 'hook:nudge', 'no reminder on coding prompts — fix: install.md → «Хук-напоминалка»')

const width = Math.max(...rows.map(([, name]) => name.length))
for (const [status, name, detail] of rows) {
  console.log(`${status.padEnd(7)} ${name.padEnd(width)}  ${detail}`)
}
