import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

// .pre-commit-hooks.yaml holds one hook of plain `key: value` lines. Reading
// them by hand keeps the package free of a YAML dependency.
function hook() {
  const fields = {}
  for (const line of read('.pre-commit-hooks.yaml').split('\n')) {
    const text = line.replace(/^- /, '').trim()
    const at = text.indexOf(': ')
    if (at < 1) continue
    let value = text.slice(at + 2)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'")
    fields[text.slice(0, at)] = value
  }
  return fields
}

test('the pre-commit hook runs the installed CLI once, without file names', () => {
  const h = hook()
  assert.equal(h.id, 'answer-crawler-check')
  assert.equal(h.language, 'node')
  assert.ok(Object.hasOwn(pkg.bin, h.entry), `entry ${h.entry} is not a bin in package.json`)
  assert.equal(h.pass_filenames, 'false')
})

test('the pre-commit hook fires on any robots.txt and nothing else', () => {
  // pre-commit tests `files` with Python's re.search, which reads this pattern the same way.
  const files = new RegExp(hook().files)
  for (const p of ['robots.txt', 'public/robots.txt', 'site/static/robots.txt']) assert.ok(files.test(p), p)
  for (const p of ['myrobots.txt', 'robots.txt.bak', 'robots.txt/index.html', 'robots_txt', 'robots.TXT']) {
    assert.ok(!files.test(p), p)
  }
})

test('package.json, CITATION.cff, --version and the README pins name one version', () => {
  const v = pkg.version
  assert.equal(read('CITATION.cff').match(/^version: "([^"]*)"$/m)?.[1], v)
  const bin = new URL('../bin/answer-crawler-check.js', import.meta.url).pathname
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), `answer-crawler-check ${v}`)
  const readme = read('README.md')
  const pins = [...readme.matchAll(/answer-crawler-check@v?(\d+\.\d+\.\d+)/g), ...readme.matchAll(/^\s*rev: v(\d+\.\d+\.\d+)$/gm)]
  assert.ok(pins.length > 0, 'the README pins no version')
  for (const m of pins) assert.equal(m[1], v, m[0])
})
