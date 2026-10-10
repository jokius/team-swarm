#!/usr/bin/env node
// Run: node hooks/isolation-guard.test.mjs   (no framework, exits non-zero on failure)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, findConfig } from './isolation-guard.mjs'

const root = mkdtempSync(join(tmpdir(), 'ts-guard-'))
mkdirSync(join(root, '.team-swarm'))
mkdirSync(join(root, 'pkg', 'src'), { recursive: true })
writeFileSync(join(root, '.team-swarm', 'isolation.json'), JSON.stringify({ tester: ['pkg/src/', '!pkg/src/api.go'], developer: ['tests/', 'pkg/golden.txt'] }))
const config = findConfig(join(root, 'pkg', 'src')) // found by walking up
assert.equal(config.root, root)

const ev = (agent_type, tool_name, tool_input = {}) => ({ agent_type, tool_name, tool_input, cwd: root })

// not a role teammate → never touched (lead, reviewer, plain subagents)
assert.equal(decide(ev(undefined, 'Read', { file_path: 'tests/a.py' }), config), null)
assert.equal(decide(ev('reviewer-f1', 'Read', { file_path: 'tests/a.py' }), config), null)
assert.equal(decide(ev('reviewer-f1', 'Agent', {}), config), null)

// role teammates never spawn or stop agents, config or not
assert.match(decide(ev('tester-f1', 'Agent', {}), null), /may not use Agent/)
assert.match(decide(ev('worker-order', 'TaskStop', {}), null), /may not use TaskStop/)

// developer: tests are off-limits through every channel
assert.match(decide(ev('developer-f1', 'Read', { file_path: join(root, 'tests', 'test_calc.py') }), config), /tests\//)
assert.match(decide(ev('developer-f1', 'Bash', { command: 'cat tests/test_calc.py' }), config), /tests\//)
assert.match(decide(ev('developer-f1', 'Grep', { pattern: 'divide' }), config), /no recognisable scope.*"path"/) // no path = whole project
assert.match(decide(ev('developer-f1', 'Grep', { pattern: 'x', path: '..' }), config), /no recognisable scope/) // ancestor of the project
assert.match(decide(ev('developer-f1', 'Grep', { pattern: 'x', path: 'tests' }), config), /tests\//)
assert.equal(decide(ev('developer-f1', 'Grep', { pattern: 'x', path: 'pkg/src' }), config), null)
assert.equal(decide(ev('developer-f1', 'Edit', { file_path: 'pkg/src/calc.go' }), config), null)
assert.equal(decide(ev('developer-f1', 'Bash', { command: 'go build ./pkg/...' }), config), null)
assert.equal(decide(ev('developer-f1', 'Read', { file_path: 'testsuite/notes.md' }), config), null) // prefix, not substring
// Bash search: unscoped or root-scoped recursive search is denied, scoped search is fine
const unscoped = [
  'rg divide', 'grep -rn divide .', 'grep -n -r divide', 'git grep divide', 'find . -name "*.py"', 'rg divide ./',
  'cd pkg && rg x', 'rg divide >/dev/null 2>&1; echo "exit=$?"', 'rg divide 2>/dev/null',
  `rg divide ${root}`, `grep -rn divide ${root}/`, 'rg divide /', // absolute project root and its ancestors
  'git diff', 'git log -p -3', 'git show HEAD', 'git stash show -p', // print file contents, no pathspec
  'git --no-pager diff', 'git -C . diff', 'git -c core.pager=cat show HEAD', 'git log -u -3', // global options, -u
  'git diff --stat && git diff', 'git log -p --stat -3', // a summary flag doesn't excuse a patch
  'git diff origin/main', 'git log -p origin/main..HEAD', // refs are not paths
]
for (const cmd of unscoped) {
  assert.match(decide(ev('developer-f1', 'Bash', { command: cmd }), config) ?? '', /no recognisable scope.*trailing slash/, cmd)
}
assert.match(decide(ev('developer-f1', 'Bash', { command: `rg divide ${root}/tests` }), config) ?? '', /may not access tests\//) // absolute, no slash
assert.match(decide(ev('developer-f1', 'Bash', { command: 'cat pkg/golden.txt' }), config) ?? '', /pkg\/golden\.txt/) // exact-path ban
assert.match(decide(ev('developer-f1', 'Bash', { command: 'git show HEAD:tests/test_calc.py' }), config) ?? '', /tests\//)
for (const cmd of ['rg divide pkg/src/', 'grep -rn divide pkg/src/calc.go', 'grep divide pkg/src/calc.go', 'go test ./pkg/src/...', 'ls pkg', 'rg divide pkg/src/ >/dev/null 2>&1',
  `rg divide ${root}/pkg/src/`, 'git diff -- pkg/src/', 'git --no-pager diff origin/main -- pkg/src/', 'git diff --stat', 'git show --stat HEAD',
  'git log --oneline -5', 'git show HEAD:pkg/src/calc.go', 'git status']) {
  assert.equal(decide(ev('developer-f1', 'Bash', { command: cmd }), config), null, cmd)
}

// tester: implementation is off-limits, tests are fine
assert.match(decide(ev('tester-f1', 'Read', { file_path: 'pkg/src/calc.go' }), config), /pkg\/src\//)
assert.match(decide(ev('tester-f1', 'Glob', { pattern: '**/*.go', path: 'pkg' }), config), /pkg\/src\//) // pkg contains pkg/src
assert.equal(decide(ev('tester-f1', 'Write', { file_path: 'tests/test_calc.py' }), config), null)
assert.equal(decide(ev('tester-f1', 'Read', { file_path: 'pkg/src/api.go' }), config), null) // "!" exception
assert.match(decide(ev('tester-f1', 'Bash', { command: 'cat pkg/src/api.go' }), config), /pkg\/src\//) // exceptions don't cover Bash

// tests next to the code (Go): a suffix ban covers every directory search, so search by file name
const go = mkdtempSync(join(tmpdir(), 'ts-guard-go-'))
mkdirSync(join(go, '.team-swarm'))
mkdirSync(join(go, 'internal', 'order'), { recursive: true })
writeFileSync(join(go, 'internal', 'order', 'order.go'), 'package order\n')
writeFileSync(join(go, 'internal', 'order', 'order_test.go'), 'package order\n')
writeFileSync(join(go, '.team-swarm', 'isolation.json'), JSON.stringify({ tester: ['internal/order/order.go'], developer: ['*_test.go'] }))
const goConfig = findConfig(go)
const gev = (agent_type, tool_name, tool_input = {}) => ({ agent_type, tool_name, tool_input, cwd: go })
assert.match(decide(gev('developer-o', 'Read', { file_path: 'internal/order/order_test.go' }), goConfig), /may not access \*_test\.go/)
assert.match(decide(gev('developer-o', 'Bash', { command: 'git show HEAD:internal/order/order_test.go' }), goConfig), /_test\.go/)
for (const cmd of ['rg Total internal/order/', 'grep -rn Total ./internal/order/', 'git diff -- internal/order/']) {
  assert.match(decide(gev('developer-o', 'Bash', { command: cmd }), goConfig) ?? '', /whole directory.*by name/, cmd)
}
assert.match(decide(gev('developer-o', 'Grep', { pattern: 'Total', path: 'internal/order' }), goConfig) ?? '', /whole directory/)
for (const cmd of ['rg Total internal/order/order.go', 'git diff -- internal/order/order.go', 'go build ./internal/order/...']) {
  assert.equal(decide(gev('developer-o', 'Bash', { command: cmd }), goConfig), null, cmd)
}
assert.match(decide(gev('tester-o', 'Bash', { command: 'cat internal/order/order.go' }), goConfig) ?? '', /may not access internal\/order\/order\.go/)
assert.match(decide(gev('tester-o', 'Bash', { command: 'rg Total internal/order/' }), goConfig) ?? '', /covers internal\/order\/order\.go/)
assert.equal(decide(gev('tester-o', 'Bash', { command: 'go test ./internal/order/...' }), goConfig), null)
assert.equal(decide(gev('tester-o', 'Read', { file_path: 'internal/order/order_test.go' }), goConfig), null)

// the isolation map and the guard are not the teammates' to change
for (const [tool, input] of [
  ['Write', { file_path: '.team-swarm/isolation.json' }], ['Edit', { file_path: join(root, '.team-swarm', 'isolation.json') }],
  ['Bash', { command: 'rm .team-swarm/isolation.json' }], ['Bash', { command: 'echo {} > .team-swarm/isolation.json' }],
  ['Write', { file_path: join(dirname(fileURLToPath(import.meta.url)), 'isolation-guard.mjs') }],
]) {
  assert.match(decide(ev('developer-f1', tool, input), config) ?? '', /may not change the isolation map/, JSON.stringify(input))
  assert.match(decide(ev('worker-order', tool, input), config) ?? '', /may not change the isolation map/) // even without own rules
}
assert.equal(decide(ev('reviewer-f1', 'Write', { file_path: '.team-swarm/isolation.json' }), config), null)

// the same file under another name: a symlink, another case on a case-insensitive disk, a glob
mkdirSync(join(root, 'tests'))
writeFileSync(join(root, 'tests', 'test_calc.py'), 'secret\n')
symlinkSync(join(root, 'tests'), join(root, 'tt'), 'dir')
assert.match(decide(ev('developer-f1', 'Read', { file_path: 'tt/test_calc.py' }), config) ?? '', /tests\//)
assert.match(decide(ev('developer-f1', 'Bash', { command: 'cat tt/test_calc.py' }), config) ?? '', /tests\//)
assert.match(decide(ev('developer-f1', 'Bash', { command: 'cat tt/*' }), config) ?? '', /tests\//)
if (existsSync(join(root, 'TESTS'))) { // case-insensitive filesystem (macOS default)
  assert.match(decide(ev('developer-f1', 'Read', { file_path: 'Tests/test_calc.py' }), config) ?? '', /tests\//)
  assert.match(decide(ev('developer-f1', 'Bash', { command: 'cat Tests/test_calc.py' }), config) ?? '', /tests\//)
}

// with a map, role teammates get file/shell/search/messaging tools only; extras via allowTools
for (const tool of ['Monitor', 'LSP', 'Artifact', 'SendUserFile', 'mcp__fs__read_file', 'EnterWorktree']) {
  assert.match(decide(ev('developer-f1', tool, { file_path: 'tests/test_calc.py' }), config) ?? '', /may not use .*allowTools/, tool)
}
for (const tool of ['Read', 'Bash', 'SendMessage', 'Skill', 'ToolSearch', 'WebSearch']) {
  assert.doesNotMatch(decide(ev('developer-f1', tool, { file_path: 'pkg/src/calc.go', command: 'ls', query: 'x' }), config) ?? '', /may not use/, tool)
}
const pw = { ...config, rules: { ...config.rules, allowTools: ['mcp__plugin_playwright_playwright__*'] } }
assert.equal(decide(ev('tester-f1', 'mcp__plugin_playwright_playwright__browser_click', {}), pw), null)
assert.equal(decide(ev('reviewer-f1', 'Monitor', {}), config), null) // reviewer is not a role teammate

// quotes and backslashes don't hide a path
for (const cmd of ['cat te""sts/test_calc.py', "cat 'tests'/test_calc.py", 'cat te\\sts/test_calc.py', 'rm .team-sw""arm/isolation.json']) {
  assert.notEqual(decide(ev('developer-f1', 'Bash', { command: cmd }), config), null, cmd)
}

// no config → only the Agent/TaskStop rule
assert.equal(decide(ev('developer-f1', 'Read', { file_path: 'tests/a.py' }), null), null)

// end to end through the shell pre-filter: role teammate gets a deny, everyone else gets nothing
const here = dirname(fileURLToPath(import.meta.url))
const run = (event) => execFileSync('sh', [join(here, 'isolation-guard.sh')], { input: JSON.stringify(event), encoding: 'utf8' })
const denied = JSON.parse(run(ev('developer-f1', 'Read', { file_path: 'tests/a.py' })))
assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
assert.equal(run(ev('lead', 'Read', { file_path: 'tests/a.py' })), '')
assert.equal(run({ tool_name: 'Read', tool_input: { file_path: 'tests/a.py' }, cwd: root }), '')

// and through a symlink — the skills-dir install path (~/.claude/skills/team-swarm -> repo),
// where swarm-nudge used to exit silently
const link = join(mkdtempSync(join(tmpdir(), 'ts-guard-link-')), 'hooks')
symlinkSync(here, link, 'dir')
const viaLink = execFileSync('sh', [join(link, 'isolation-guard.sh')], { input: JSON.stringify(ev('tester-f1', 'Agent', {})), encoding: 'utf8' })
assert.equal(JSON.parse(viaLink).hookSpecificOutput.permissionDecision, 'deny')

console.log('isolation-guard: all tests passed')
