#!/usr/bin/env node
// Run: node hooks/swarm-nudge.test.mjs   (no framework, exits non-zero on failure)
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMode, shouldNudge, transcriptHasSkillCall } from './swarm-nudge.mjs'

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
const withCall = join(dir, 'with-call.jsonl')
const withoutCall = join(dir, 'without-call.jsonl')
const filler = `${'x'.repeat(4096)}\n`.repeat(600) // ~2.4 MB, several read chunks
writeFileSync(withCall, `${filler}{"name":"Skill","input":{"skill":"team-swarm"}}\n${filler}`)
// our own nudge text mentions the skill by name — it must NOT read as "already ran"
writeFileSync(withoutCall, `${filler}enter the team-swarm skill (Skill tool, skill name: team-swarm)\n${filler}`)

assert.equal(await transcriptHasSkillCall(withCall), true)
assert.equal(await transcriptHasSkillCall(withoutCall), false)
assert.equal(await transcriptHasSkillCall(join(dir, 'missing.jsonl')), false)

console.log('swarm-nudge: all checks passed')
