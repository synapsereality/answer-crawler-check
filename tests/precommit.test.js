import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

// .pre-commit-hooks.yaml holds plain `key: value` lines, one list item per
// hook. Reading them by hand keeps the package free of a YAML dependency.
function hooks() {
  const all = []
  for (const line of read('.pre-commit-hooks.yaml').split('\n')) {
    if (line.startsWith('- ')) all.push({})
    const text = line.replace(/^- /, '').trim()
    const at = text.indexOf(': ')
    if (at < 1) continue
    let value = text.slice(at + 2)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'")
    all.at(-1)[text.slice(0, at)] = value
  }
  return all
}

test('the pre-commit manifest holds one hook that runs the installed CLI once, without file names', () => {
  const all = hooks()
  assert.equal(all.length, 1)
  const [h] = all
  // Any other key, such as always_run, types or exclude, changes when the hook fires.
  assert.deepEqual(Object.keys(h).sort(), ['description', 'entry', 'files', 'id', 'language', 'name', 'pass_filenames'])
  assert.equal(h.id, 'answer-crawler-check')
  assert.equal(h.language, 'node')
  assert.ok(Object.hasOwn(pkg.bin, h.entry), `entry ${h.entry} is not a bin in package.json`)
  assert.equal(h.pass_filenames, 'false')
})

test('the pre-commit hook fires on any robots.txt and nothing else', () => {
  // pre-commit tests `files` with Python's re.search, which reads this pattern the same way.
  const files = new RegExp(hooks()[0].files)
  for (const p of ['robots.txt', 'public/robots.txt', 'site/static/robots.txt']) assert.ok(files.test(p), p)
  for (const p of ['myrobots.txt', 'robots.txt.bak', 'robots.txt/index.html', 'robots_txt', 'robots.TXT']) {
    assert.ok(!files.test(p), p)
  }
})

test('package.json, CITATION.cff, --version and the README pins name one version', () => {
  const v = pkg.version
  assert.equal(read('CITATION.cff').match(/^version: "([^"]*)"$/m)?.[1], v)
  const bin = fileURLToPath(new URL('../bin/answer-crawler-check.js', import.meta.url))
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), `answer-crawler-check ${v}`)
  const readme = read('README.md')
  const pins = [
    ...readme.matchAll(/answer-crawler-check@v?(\d+\.\d+\.\d+)/g),
    ...readme.matchAll(/^\s*rev:\s*["']?v?(\d+\.\d+\.\d+)/gm),
  ]
  assert.ok(pins.some((m) => m[0].includes('rev:')), 'the README pins no pre-commit rev')
  for (const m of pins) assert.equal(m[1], v, m[0])
  // The newest CHANGELOG entry is this version. The release workflow runs these
  // tests too, and there the entry must carry its date.
  const heading = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)(.*)$/m)
  assert.equal(heading?.[1], v, 'CHANGELOG.md has no entry for this version')
  if (process.env.GITHUB_EVENT_NAME === 'release') assert.match(heading[2], /^, \d{4}-\d{2}-\d{2}$/, heading[0])
})
