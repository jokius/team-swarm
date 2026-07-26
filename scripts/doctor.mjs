#!/usr/bin/env node
// team-swarm doctor — checks the environment AROUND the skill.
// Run: node scripts/doctor.mjs
//
// Deliberately does NOT check Agent / SendMessage / Workflow: those live in the
// session's tool list, not on disk, so only the model can see them. The skill's own
// Preflight gate covers them (SKILL.md → "Требования среды и Preflight-гейт").
//
// Output is one line per check: STATUS  name  detail
// STATUS is OK | MISS | OFF | UNKNOWN. Lines with a "fix:" are safe to run as-is.

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

// 1. Claude Code itself
const version = run('claude', ['--version'])
add(
  version ? 'OK' : 'UNKNOWN',
  'claude',
  version ? version.trim().split('\n').pop().trim() : 'CLI not on PATH — checks below may be incomplete',
)

// 2. node — the nudge hook runs on it
add('OK', 'node', process.version)

// 3. Recommended plugins
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

// 4. How team-swarm itself is loaded
if (pluginList && /\bteam-swarm@/.test(pluginList)) {
  const id = pluginList.match(/team-swarm@[\w-]+/)[0]
  add('OK', 'skill:team-swarm', `loaded as plugin ${id}`)
} else if (existsSync(join(configDir, 'skills', 'team-swarm', 'SKILL.md'))) {
  add('OK', 'skill:team-swarm', `plain skill at ${join(configDir, 'skills', 'team-swarm')} (hook needs the plugin manifest — restart the session)`)
} else {
  add('MISS', 'skill:team-swarm', 'not found in this config dir — is CLAUDE_CONFIG_DIR pointing somewhere else?')
}

// 5. Nudge hook state. Env wins over the plugin's userConfig, same as in the hook.
const envMode = (process.env.TEAM_SWARM_NUDGE || '').trim().toLowerCase()
let settings = {}
try {
  settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
} catch {
  settings = {}
}
const settingsMode = String(settings.env?.TEAM_SWARM_NUDGE ?? '').trim().toLowerCase()
const configuredNudge = Object.entries(settings.pluginConfigs ?? {})
  .filter(([id]) => id.startsWith('team-swarm@'))
  .map(([, value]) => value?.options?.nudge)
  .find((value) => value !== undefined)

const OFF = new Set(['', 'off', 'false', '0', 'no'])
if (envMode && !OFF.has(envMode)) add('OK', 'hook:nudge', `${envMode} (TEAM_SWARM_NUDGE in this process)`)
else if (settingsMode && !OFF.has(settingsMode)) add('OK', 'hook:nudge', `${settingsMode} (env in ${join(configDir, 'settings.json')})`)
else if (configuredNudge !== undefined && !OFF.has(String(configuredNudge).toLowerCase()))
  add('OK', 'hook:nudge', `${configuredNudge} (plugin userConfig)`)
else add('OFF', 'hook:nudge', 'no reminder on coding prompts — fix: install.md → «Хук-напоминалка»')

const width = Math.max(...rows.map(([, name]) => name.length))
for (const [status, name, detail] of rows) {
  console.log(`${status.padEnd(7)} ${name.padEnd(width)}  ${detail}`)
}
