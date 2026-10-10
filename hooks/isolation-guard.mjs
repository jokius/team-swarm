#!/usr/bin/env node
// team-swarm — PreToolUse isolation guard for teammates.
//
// Enforces what the role briefs ask for, so isolation does not rest on prompts alone:
//   - tester-* / developer-* / worker-* teammates may not spawn subagents (Agent) or
//     stop agents (TaskStop): a child survives its parent's TaskStop and is a side
//     channel around the read bans;
//   - tester-* / developer-* may not touch the paths the lead listed for their role in
//     .team-swarm/isolation.json ("dir/", "*suffix", exact path; "!path" = exception) (tests written blind only prove the spec if the code
//     is written blind too, and vice versa).
//
// Verified live on Claude Code 2.1.296: plugin hooks fire inside in-process teammates,
// and for a teammate hook input's agent_type is the teammate's NAME — so the role is the
// name prefix (stage-unique names: tester-<feature>, developer-<feature>, worker-<sector>).
// Undocumented behaviour: if it changes, the guard silently degrades to prompt-only.
//
// Threat model: cooperative agents that leak by accident or drift casually — not an agent
// that sets out to beat the guard. Bash is a general-purpose language: variables
// (d=tests; cat $d/x), interpreters (python -c with built strings) or test-runner output
// get through any string check. A hard boundary would need a worktree without the other
// side's files. Within that model: Bash is matched by substring and by the existing paths
// it names (canonical form); a search without a path (Grep/Glob, or rg / grep -r / find /
// git grep / git diff in Bash) counts as searching the whole project. Never crashes the tool call — any error means allow.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESTRICTED = /^(tester|developer|worker)-/
const NO_SPAWN_TOOLS = new Set(['Agent', 'TaskStop'])
const RECURSIVE_SEARCH = /(^|[\s;|&(])(rg|ag|ack|fd|find|tree)(\s|$)|\bgit\s+grep\b|\bgrep\b[^|;&]*\s(-\w*[rR]\w*|--recursive)\b/
// git commands that print file contents (global options like --no-pager / -C dir allowed
// before the subcommand); without a pathspec they cover the whole project
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w.-]+(?:=\S+)?))*\s+`
const GIT_CONTENT = new RegExp(`${GIT}(?:diff|show|stash\\s+show)\\b|${GIT}log\\b.*\\s(?:-p|-u|--patch)\\b`)
const GIT_SUMMARY = /\s--(?:stat|shortstat|numstat|name-only|name-status)\b/
const GIT_PATCH = /\s(?:-p|-u|--patch)\b/
const isGitContent = (seg) => GIT_CONTENT.test(seg) && !(GIT_SUMMARY.test(seg) && !GIT_PATCH.test(seg))

const words = (seg) => seg.trim().split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'))
const notOperand = (t) => !t || t.startsWith('-') || /^\d*[<>]/.test(t) || t.startsWith('/dev/')

// Search tools: path-looking arguments — contain "/", or are "." / "*" / "~…". A bare
// name ("src") is not recognised, so the scope must be written as "src/".
function searchTargets(seg, cwd) {
  return words(seg)
    .filter((t) => !notOperand(t) && (t.includes('/') || t === '.' || t === '*' || t.startsWith('~')))
    .map((t) => resolve(cwd, t === '*' ? '.' : expandHome(t)))
}

// git: only a pathspec after "--" or a <rev>:<path> argument names files; refs such as
// origin/main are not paths.
function gitTargets(seg, cwd, root) {
  const w = words(seg)
  const dash = w.indexOf('--')
  const specs = dash === -1 ? [] : w.slice(dash + 1).filter((t) => !notOperand(t)).map((t) => resolve(cwd, expandHome(t)))
  const revPaths = w.map((t) => t.match(/^[^\s:/-][^\s:]*:(.+)$/)?.[1]).filter(Boolean).map((p) => resolve(root, p))
  return [...specs, ...revPaths]
}

// The search root is the project root or one of its ancestors.
const coversRoot = (abs, root) => {
  const r = relative(abs, root)
  return !r.startsWith('..') && !isAbsolute(r)
}
const expandHome = (t) => (t.startsWith('~') ? join(homedir(), t.slice(1)) : t)

// Canonical path: symlinks resolved and, on case-insensitive filesystems, the on-disk case
// (realpath.native does that, plain realpath doesn't). A path that doesn't exist yet keeps
// its tail under the canonical form of its nearest existing ancestor.
function canon(p) {
  try {
    return realpathSync.native(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : join(canon(parent), basename(p))
  }
}

// Every word of a shell command that names an existing path (globs: the part before the
// wildcard), so a symlink (`t -> tests`) or another case (`Tests/`) can't slip past the
// substring check.
function existingPaths(cmd, cwd) {
  const out = []
  for (const raw of cmd.split(/[\s;|&()<>]+/)) {
    let t = raw.replace(/^(['"])(.*)\1$/, '$2')
    if (!t || t.startsWith('-')) continue
    const glob = t.search(/[*?[]/)
    if (glob === 0) continue
    if (glob > 0) t = t.slice(0, glob).replace(/[^/]*$/, '') || '.'
    const abs = resolve(cwd, expandHome(t))
    if (existsSync(abs)) out.push(abs)
  }
  return out
}

// With a map in place, role teammates get file, shell, search and messaging tools only, so the
// map covers everything they can read (Monitor, LSP, Artifact, MCP readers… would not be).
// Extra tools: "allowTools" in the map, e.g. ["mcp__plugin_playwright_playwright__*"].
const ROLE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob',
  'SendMessage', 'ToolSearch', 'Skill', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite',
])
const toolAllowed = (tool, extra) =>
  ROLE_TOOLS.has(tool) || extra.some((p) => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))

// Quotes and backslashes don't change which file a shell word names: te""sts → tests.
const unquote = (cmd) => cmd.replace(/\\(.)/g, '$1').replace(/["']/g, '')

// The lead's isolation map and the guard itself are off-limits to the teammates they bind.
const POLICY_TEXT = /\.team-swarm|isolation\.json|isolation-guard/
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const GUARD_FILES = (() => {
  try {
    const dir = dirname(canon(fileURLToPath(import.meta.url)))
    return new Set(['isolation-guard.mjs', 'isolation-guard.sh', 'hooks.json'].map((f) => join(dir, f)))
  } catch {
    return new Set()
  }
})()

// Walk up from cwd to the first directory holding .team-swarm/isolation.json.
export function findConfig(cwd) {
  let dir = resolve(cwd || '.')
  for (;;) {
    const file = join(dir, '.team-swarm', 'isolation.json')
    if (existsSync(file)) return { root: dir, rules: JSON.parse(readFileSync(file, 'utf8')) }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// "dir/" → that directory; "*suffix" → any file ending with suffix; else exact path.
function hits(rel, pattern) {
  const p = rel.split(sep).join('/')
  if (pattern.startsWith('*')) return p.endsWith(pattern.slice(1))
  const base = pattern.replace(/\/+$/, '')
  return p === base || p.startsWith(base + '/')
}

// A search rooted at `rel` reaches files matched by `pattern`. A suffix ban ("*_test.go")
// can sit in any directory, so every directory search covers it.
function searchCovers(rel, pattern, root) {
  if (pattern.startsWith('*')) {
    try {
      return statSync(resolve(root, rel)).isDirectory()
    } catch {
      return false
    }
  }
  const p = rel.split(sep).join('/')
  const base = pattern.replace(/\/+$/, '')
  return p === '' || p === '.' || base.startsWith(p + '/') || hits(rel, pattern)
}

export function decide(event, config) {
  const name = String(event.agent_type ?? '')
  const role = name.match(RESTRICTED)?.[1]
  if (!role) return null
  const tool = event.tool_name
  if (NO_SPAWN_TOOLS.has(tool)) {
    return `${name} may not use ${tool}: teammates don't spawn or stop agents (a child outlives TaskStop and bypasses isolation). Ask the lead via SendMessage to "main".`
  }
  if (!config) return null
  const input = event.tool_input ?? {}
  const root = canon(config.root)
  const cwd = event.cwd || config.root
  const abs = (p) => canon(resolve(cwd, expandHome(String(p))))
  const relOf = (p) => relative(root, abs(p))

  const extra = Array.isArray(config.rules?.allowTools) ? config.rules.allowTools.map(String) : []
  if (!toolAllowed(tool, extra)) {
    return `team-swarm isolation: ${name} may not use ${tool}: role teammates work with file, shell, search and messaging tools, so the isolation map covers everything they read. If the lead wants it, it goes into "allowTools" in .team-swarm/isolation.json. Ask the lead via SendMessage to "main".`
  }

  const policy = `team-swarm isolation: ${name} may not change the isolation map (.team-swarm/) or the guard — they belong to the lead. Ask the lead via SendMessage to "main".`
  if (tool === 'Bash' && POLICY_TEXT.test(unquote(String(input.command ?? '')))) return policy
  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path
    if (target) {
      const rel = relOf(target)
      if (rel === '.team-swarm' || rel.startsWith('.team-swarm' + sep) || GUARD_FILES.has(abs(target))) return policy
    }
  }

  const rules = config.rules?.[role]
  if (!Array.isArray(rules) || rules.length === 0) return null
  // "!path" carves an exception out of a ban (e.g. an interface file inside src/); not for Bash
  const forbidden = rules.filter((r) => !r.startsWith('!'))
  const allowed = rules.filter((r) => r.startsWith('!')).map((r) => r.slice(1))

  const why = role === 'tester'
    ? 'tests are written blind from the spec, without seeing the implementation'
    : 'the implementation is written blind from the spec, without seeing the tests'
  const deny = (pattern) =>
    `team-swarm isolation: ${name} may not access ${pattern} — ${why}. Work from the spec; ask the lead via SendMessage to "main" if something is missing.`

  // Scope problems (the search is too wide) say how to re-run; deny() above is the boundary.
  const scope = (what, how) => `team-swarm isolation: ${name}'s search ${what}. This is about the scope, not about your own files: ${how}.`
  const narrower = tool === 'Bash'
    ? 're-run it on your own directories written with a trailing slash, e.g. "rg <pattern> <your-dir>/" or "git diff -- <your-dir>/"'
    : 're-run it with "path" set to one of your own directories'
  const unscoped = () => scope(`has no recognisable scope, so it would cover the whole project, ${forbidden.join(', ')} included`, narrower)
  const covering = (f) => f.startsWith('*')
    ? scope(`covers a whole directory, and ${f} files may sit next to your code there`, 're-run it on your own files by name, e.g. "rg <pattern> path/to/file"')
    : scope(`covers ${f}, which is off-limits`, 're-run it on a narrower path inside your own directories')

  // Scope check for one search root: whole project → unscoped; inside a ban → boundary;
  // above a ban → too wide.
  const checkRoot = (searchRoot) => {
    const target = canon(searchRoot)
    if (coversRoot(target, root)) return unscoped()
    const rel = relative(root, target)
    if (allowed.some((a) => hits(rel, a))) return null
    const inside = forbidden.find((f) => hits(rel, f))
    if (inside) return deny(inside)
    const over = forbidden.find((f) => searchCovers(rel, f, root))
    return over ? covering(over) : null
  }

  if (tool === 'Bash') {
    const cmd = unquote(String(input.command ?? ''))
    // "*sfx" → sfx, "dir/" → "dir/", exact path → itself (substring match, best effort)
    const needle = (f) => (f.startsWith('*') ? f.slice(1) : f.endsWith('/') ? f.replace(/\/+$/, '/') : f)
    const hit = forbidden.find((f) => cmd.includes(needle(f)))
    if (hit) return deny(hit)
    for (const p of existingPaths(cmd, cwd)) {
      const rel = relative(root, canon(p))
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      const inside = forbidden.find((f) => hits(rel, f))
      if (inside) return deny(inside)
    }
    // where Grep/Glob are off, search goes through Bash: `rg x`, `grep -rn x .` or a bare
    // `git diff` walks the whole project, forbidden dirs included — demand explicit own paths.
    // Each ; && || | segment is judged on its own.
    for (const seg of cmd.split(/;|&&|\|\||\||\n/)) {
      const targets = isGitContent(seg) ? gitTargets(seg, cwd, root)
        : RECURSIVE_SEARCH.test(seg) ? searchTargets(seg, cwd)
        : null
      if (!targets) continue
      if (targets.length === 0) return unscoped()
      for (const abs of targets) {
        const verdict = checkRoot(abs)
        if (verdict) return verdict
      }
    }
    return null
  }
  if (tool === 'Grep' || tool === 'Glob') return checkRoot(resolve(cwd, input.path || cwd))
  const file = input.file_path ?? input.notebook_path
  if (!file) return null
  const rel = relOf(String(file))
  if (allowed.some((a) => hits(rel, a))) return null
  const hit = forbidden.find((f) => hits(rel, f))
  return hit ? deny(hit) : null
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  let event
  try {
    event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return
  }
  let config = null
  try {
    config = findConfig(event.cwd)
  } catch {
    config = null // broken config = no path rules; the Agent/TaskStop rule still holds
  }
  let reason = null
  try {
    reason = decide(event, config)
  } catch {
    return // a guard bug must not break the teammate's tool call — fail open
  }
  if (!reason) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (process.argv[1] && isMain()) await main()
