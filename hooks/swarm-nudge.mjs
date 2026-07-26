#!/usr/bin/env node
// team-swarm — UserPromptSubmit nudge.
//
// Reminds Claude to enter the team-swarm skill on work-shaped prompts. It does NOT
// judge task size or execution mode: the skill already does that (see SKILL.md →
// "Оценка перед формированием команды" and "Выбор режима исполнения"). This hook only
// gets Claude through the door; the skill decides solo vs team and TDD vs fan-out.
//
// Off by default. Enable with TEAM_SWARM_NUDGE=smart|always (env, wins) or the
// plugin's `nudge` userConfig option (exported as CLAUDE_PLUGIN_OPTION_NUDGE).

import { createReadStream } from 'node:fs'
import { pathToFileURL } from 'node:url'

// How a real skill invocation looks in the transcript JSONL — verified empirically:
// {"name":"Skill","input":{"skill":"team-swarm","args":"..."}}
// The nudge text below deliberately avoids this exact substring, so we detect the
// skill actually running, not our own reminder from an earlier turn.
const SKILL_CALL = '"skill":"team-swarm"'

const MIN_LENGTH = 12

// \b is ASCII-only in JS, so Cyrillic alternatives need an explicit Unicode
// letter boundary — /\bпочему\b/ never matches. Hence (?<!\p{L}) … (?!\p{L}) + /u.
const SKIP = [
  /^[/!@#$]/, //                                                     slash command, bash mode, memory shortcut
  /^(?:почему|зачем|что такое|что за|объясни|расскажи|как работает|как устроен|why|what is|what's|explain|how does)(?!\p{L})/iu,
  /(?<!\p{L})(?:соло|сам сделай|без команды|не собирай|solo|no team|yourself)(?!\p{L})/iu,
]

const NUDGE = [
  '[team-swarm] Looks like work on code.',
  'Before writing or planning it, enter the team-swarm skill (Skill tool, skill name: team-swarm).',
  'It runs its own preflight, decides whether the task is trivial enough to do solo, and picks the execution mode.',
  'If you deliberately skip it, tell the user why in one line.',
].join(' ')

export function normalizeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  if (mode === '' || mode === 'off' || mode === 'false' || mode === '0' || mode === 'no') return 'off'
  if (mode === 'always') return 'always'
  return 'smart'
}

export function shouldNudge(prompt, skillAlreadyRan = false, mode = 'smart') {
  if (mode === 'off') return false
  const text = String(prompt ?? '').trim()
  if (!text) return false
  if (skillAlreadyRan) return false // team already up in this session — stop reminding
  if (mode === 'always') return true
  if (text.length < MIN_LENGTH) return false
  return !SKIP.some((pattern) => pattern.test(text))
}

// Scan from the start and bail on the first hit: the skill is usually invoked early
// in a session, so this normally reads one chunk. (Reading only the tail misses it —
// found the hard way on an 810 KB transcript whose skill call sat at byte 94k.)
export function transcriptHasSkillCall(path) {
  return new Promise((resolve) => {
    let carry = ''
    const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
    stream.on('data', (chunk) => {
      const text = carry + chunk
      if (text.includes(SKILL_CALL)) {
        stream.destroy()
        resolve(true)
        return
      }
      carry = text.slice(-SKILL_CALL.length) // keep an overlap so a split match still hits
    })
    stream.on('close', () => resolve(false))
    // no transcript, no anti-spam — one nudge too many beats crashing the prompt
    stream.on('error', () => resolve(false))
  })
}

async function main() {
  const mode = normalizeMode(process.env.TEAM_SWARM_NUDGE ?? process.env.CLAUDE_PLUGIN_OPTION_NUDGE)
  if (mode === 'off') return

  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  let event
  try {
    event = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''))
  } catch {
    return
  }

  const skillAlreadyRan = event.transcript_path ? await transcriptHasSkillCall(event.transcript_path) : false
  if (!shouldNudge(event.prompt, skillAlreadyRan, mode)) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: NUDGE },
    }),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
