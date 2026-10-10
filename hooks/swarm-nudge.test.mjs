#!/usr/bin/env node
// Run: node hooks/swarm-nudge.test.mjs   (no framework, exits non-zero on failure)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NUDGE, normalizeMode, shouldNudge, transcriptHasSkillCall } from './swarm-nudge.mjs'

// nudges on work-shaped prompts
assert.equal(shouldNudge('добавь ретраи в клиент нотификаций'), true)
assert.equal(shouldNudge('refactor the payment module to use the new API'), true)
assert.equal(shouldNudge('почини падающий тест на пагинации'), true)

// stays quiet on questions, chatter, commands and explicit solo requests
assert.equal(shouldNudge('почему тут падает тест?'), false)
assert.equal(shouldNudge('what is a swarm anyway'), false)
assert.equal(shouldNudge('ок, спасибо'), false)
assert.equal(shouldNudge('/team-swarm install'), false)
assert.equal(shouldNudge('сделай сам, без команды: поправь опечатку'), false)

// stays quiet on injected prompts: agent messages and task notifications reach
// UserPromptSubmit as a plain prompt (#94675) — in every mode, they are not typed
assert.equal(shouldNudge('<agent-message from="helper">добавь ретраи в клиент нотификаций</agent-message>'), false)
assert.equal(shouldNudge('<task-notification>refactor the payment module finished</task-notification>'), false)
assert.equal(shouldNudge('<agent-message from="helper">ok</agent-message>', false, 'always'), false)

// modes
assert.equal(shouldNudge('добавь ретраи', false, 'off'), false)
assert.equal(shouldNudge('почему падает?', false, 'always'), true)
assert.equal(shouldNudge('добавь ретраи', true, 'always'), false)
assert.equal(normalizeMode(undefined), 'off')
assert.equal(normalizeMode('false'), 'off')
assert.equal(normalizeMode('true'), 'smart')
assert.equal(normalizeMode('ALWAYS'), 'always')

// anti-spam scans the whole transcript, not just its tail: a real session logs the
// skill call early and megabytes of work after it.
const dir = mkdtempSync(join(tmpdir(), 'swarm-nudge-'))
const transcript = (name, body) => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}
const filler = `${'x'.repeat(4096)}\n`.repeat(600) // ~2.4 MB, several read chunks

// skills-dir install logs the bare name, a marketplace install the namespaced one
const bare = transcript('bare.jsonl', `${filler}{"name":"Skill","input":{"skill":"team-swarm"}}\n${filler}`)
const namespaced = transcript('ns.jsonl', `${filler}{"name":"Skill","input":{"skill":"team-swarm:team-swarm"}}\n${filler}`)
// a call split across the 1 MiB read-chunk edge must still be found: 25 of the 31
// chars of "skill":"team-swarm:team-swarm" land before the edge — more than a carry
// sized to the bare form would keep
const CALL = '{"name":"Skill","input":{"skill":"team-swarm:team-swarm"}}'
const split = transcript('split.jsonl', `${'x'.repeat((1 << 20) - CALL.indexOf('"skill"') - 25)}${CALL}\n`)
// our own nudge, as the transcript stores it (JSON-encoded) — must NOT read as "already ran"
const ownNudge = transcript('own-nudge.jsonl', `${filler}{"additionalContext":${JSON.stringify(NUDGE)}}\n${filler}`)
// another skill whose name merely ends in team-swarm is not ours
const other = transcript('other.jsonl', `{"name":"Skill","input":{"skill":"team-swarm-extras"}}\n`)

assert.equal(await transcriptHasSkillCall(bare), true)
assert.equal(await transcriptHasSkillCall(namespaced), true)
assert.equal(await transcriptHasSkillCall(split), true)
assert.equal(await transcriptHasSkillCall(ownNudge), false)
assert.equal(await transcriptHasSkillCall(other), false)
assert.equal(await transcriptHasSkillCall(join(dir, 'missing.jsonl')), false)

// runs when invoked through a symlink — the skills-dir install path
// (~/.claude/skills/team-swarm -> the repo). It used to exit 0 with no output there.
const link = join(dir, 'hooks-link')
symlinkSync(dirname(fileURLToPath(import.meta.url)), link, 'dir')
const run = spawnSync(process.execPath, [join(link, 'swarm-nudge.mjs')], {
  input: JSON.stringify({ prompt: 'реализуй функцию сортировки списка', transcript_path: join(dir, 'missing.jsonl') }),
  env: { ...process.env, TEAM_SWARM_NUDGE: 'smart' },
  encoding: 'utf8',
})
assert.equal(run.status, 0, run.stderr)
assert.notEqual(run.stdout, '', 'hook printed nothing when run through a symlink')
assert.equal(JSON.parse(run.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit')

console.log('swarm-nudge: all checks passed')
