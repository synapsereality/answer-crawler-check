import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  JSON_FILE,
  PAGE_URL,
  SVG_FILE,
  badgeLayout,
  badgeSvg,
  badgeText,
  endpointJson,
  escapeXml,
  isAllowed,
  main,
  measure,
  readVectors,
} from '../scripts/rfc9309-vectors-badge.mjs'

// scripts/rfc9309-vectors-badge.mjs runs the RFC 9309 test vectors and writes
// the badge. These tests use small vector files of their own, so they need no
// network. The rfc9309-vectors CI job runs the real file.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const dirs = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-badge-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const vector = (id, path, expected) => ({ id, robots_txt: 'User-agent: *\nDisallow: /private\n', user_agent: 'ExampleBot', path, expected })
const FILE = {
  name: 'test vectors',
  version: '1.0.0',
  vectors: [vector('open-page', '/a', 'allowed'), vector('second-page', '/b', 'allowed'), vector('private-page', '/private', 'disallowed')],
}
// A stub parser that reads every vector right except second-page.
const answers = { '/a': true, '/b': false, '/private': false }
const stub = (robotsTxt, userAgent, path) => answers[path]

function vectorsFile(data = FILE) {
  const path = join(tempDir(), 'vectors.json')
  writeFileSync(path, JSON.stringify(data))
  return path
}
function capture() {
  const lines = []
  return { lines, out: (s) => lines.push(s), err: (s) => lines.push(s) }
}

test('a stub parser that misses one vector gets the plain count, and --known keeps the run green', async () => {
  const source = vectorsFile()
  const out = tempDir()
  const io = capture()
  assert.equal(await main(['--vectors', source, '--out', out], stub, io), 1)
  assert.ok(io.lines.includes('second-page: expected allowed, got disallowed'))
  assert.ok(io.lines.includes('2 of 3 as expected, RFC 9309 vectors v1.0.0'))
  const svg = readFileSync(join(out, SVG_FILE), 'utf8')
  const json = readFileSync(join(out, JSON_FILE), 'utf8')
  assert.equal(svg, badgeSvg({ label: 'RFC 9309 vectors v1.0.0', message: '2 of 3' }))
  assert.equal(JSON.parse(json).message, '2 of 3')

  // Listed as known, the miss no longer fails the run, and the badge is the same.
  const known = capture()
  assert.equal(await main(['--vectors', source, '--out', out, '--known', 'second-page'], stub, known), 0)
  assert.ok(known.lines.includes('second-page: expected allowed, got disallowed (known)'))
  assert.equal(readFileSync(join(out, SVG_FILE), 'utf8'), svg)
  assert.equal(readFileSync(join(out, JSON_FILE), 'utf8'), json)
})

test('--check passes on files that match the run and fails on stale or missing ones, writing nothing', async () => {
  const source = vectorsFile()
  const out = tempDir()
  assert.equal(await main(['--vectors', source, '--check', '--known', 'second-page', '--out', out], stub, capture()), 1)
  assert.equal(existsSync(join(out, SVG_FILE)), false)
  assert.equal(await main(['--vectors', source, '--known', 'second-page', '--out', out], stub, capture()), 0)
  assert.equal(await main(['--vectors', source, '--known', 'second-page', '--out', out, '--check'], stub, capture()), 0)
  // A parser that now reads every vector right makes the committed badge stale.
  const io = capture()
  assert.equal(await main(['--vectors', source, '--out', out, '--check'], (r, u, p) => p !== '/private', io), 1)
  assert.ok(io.lines.some((l) => l.startsWith('out of date: ')))
  assert.match(readFileSync(join(out, SVG_FILE), 'utf8'), />2 of 3</)
  // Line ends a checkout turned into CRLF still match.
  writeFileSync(join(out, JSON_FILE), readFileSync(join(out, JSON_FILE), 'utf8').replace(/\n/g, '\r\n'))
  assert.equal(await main(['--vectors', source, '--known', 'second-page', '--out', out, '--check'], stub, capture()), 0)
})

test('an isAllowed that fails on every vector writes nothing and exits 2', async () => {
  const out = tempDir()
  const io = capture()
  const broken = () => {
    throw new Error('no parser here')
  }
  assert.equal(await main(['--vectors', vectorsFile(), '--out', out], broken, io), 2)
  assert.match(io.lines.join('\n'), /isAllowed failed on every vector, so no badge was written\. The first error: no parser here/)
  assert.equal(existsSync(join(out, SVG_FILE)), false)
  assert.equal(existsSync(join(out, JSON_FILE)), false)
})

test('an answer that is not true or false, or an error on one vector, counts as a miss', async () => {
  const result = await measure(FILE.vectors, (r, u, path) => {
    if (path === '/a') return undefined
    if (path === '/b') throw new Error('parser crashed')
    return Promise.resolve(false)
  })
  assert.equal(result.passed, 1)
  assert.equal(result.errors, 2)
  assert.deepEqual(
    result.missed.map((m) => [m.id, m.error]),
    [
      ['open-page', 'isAllowed returned undefined, not true or false'],
      ['second-page', 'parser crashed'],
    ],
  )
})

test('a known id that passes is reported, and an id the file lacks is named', async () => {
  const io = capture()
  const code = await main(['--vectors', vectorsFile(), '--out', tempDir(), '--known', 'open-page,no-such-vector', '--known', 'second-page'], stub, io)
  assert.equal(code, 0)
  assert.ok(io.lines.includes('open-page: now gives the expected result, so it can come off --known'))
  assert.ok(io.lines.includes('--known no-such-vector: no vector in version 1.0.0 has this id'))
})

test('readVectors refuses a file this script cannot read', () => {
  assert.deepEqual(readVectors(FILE), { version: '1.0.0', vectors: FILE.vectors })
  assert.equal(readVectors({ ...FILE, version: '1.4.2' }).version, '1.4.2')
  const refused = [
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{ ...FILE, version: 'v1' }, /no version such as 1\.0\.0/],
    [{ ...FILE, version: '2.0.0' }, /reads version 1 of the vectors and the file is version 2\.0\.0\. Get the current script from https:/],
    [{ ...FILE, vectors: [] }, /holds no vectors/],
    [{ ...FILE, vectors: [{ ...FILE.vectors[0], expected: 'blocked' }] }, /vector 1 needs/],
    [{ ...FILE, vectors: [{ ...FILE.vectors[0], path: 7 }] }, /vector 1 needs/],
    [{ ...FILE, vectors: [FILE.vectors[0], FILE.vectors[0]] }, /the id open-page is used twice/],
  ]
  for (const [data, message] of refused) assert.throws(() => readVectors(data), message)
})

let server
let base
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/vectors.json') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(FILE))
    else res.writeHead(404).end()
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

test('the vectors load from a URL, and a URL that fails exits 2', async () => {
  const io = capture()
  assert.equal(await main(['--vectors', `${base}/vectors.json`, '--out', tempDir(), '--known', 'second-page'], stub, io), 0)
  const missing = capture()
  assert.equal(await main(['--vectors', `${base}/gone.json`, '--out', tempDir()], stub, missing), 2)
  assert.match(missing.lines.join('\n'), /answered 404/)
  assert.equal(await main(['--vectors', join(tempDir(), 'none.json')], stub, capture()), 2)
})

test('a flag it does not know exits 2 before anything runs', async () => {
  let calls = 0
  const io = capture()
  assert.equal(await main(['--out', tempDir(), '--force'], () => calls++ > -1, io), 2)
  assert.equal(calls, 0)
  assert.match(io.lines.join('\n'), /usage: node rfc9309-vectors-badge\.mjs/)
})

test('the SVG for 52 of 55 is the snapshot, byte for byte', () => {
  const text = badgeText('1.0.0', 52, 55)
  assert.deepEqual(text, { label: 'RFC 9309 vectors v1.0.0', message: '52 of 55' })
  assert.equal(badgeSvg(text), read('tests/fixtures/rfc9309-vectors-badge.svg'))
  assert.deepEqual(badgeLayout(text), { width: 229, height: 20, labelWidth: 164, messageWidth: 65, labelText: 152, messageText: 53 })
  assert.equal(
    endpointJson(text),
    '{\n  "schemaVersion": 1,\n  "label": "RFC 9309 vectors v1.0.0",\n  "message": "52 of 55",\n  "labelColor": "27272a",\n  "color": "090a0c",\n  "style": "flat-square"\n}\n',
  )
})

test('badge text is escaped in one pass, and text XML cannot carry is refused', () => {
  assert.equal(escapeXml(`a<b>&"c'`), 'a&lt;b&gt;&amp;&quot;c&apos;')
  // Escaped once: an entity in the input is escaped again, never decoded.
  assert.equal(escapeXml('&lt;'), '&amp;lt;')
  const svg = badgeSvg({ label: '<script>alert(1)</script>', message: '"x" & \'y\'' })
  assert.ok(!svg.includes('<script'))
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(svg.includes('aria-label="&lt;script&gt;alert(1)&lt;/script&gt;: &quot;x&quot; &amp; &apos;y&apos;"'))
  assert.throws(() => escapeXml('bell\u0007'), /XML cannot carry/)
})

test('the badge says a version and a count, and nothing else', () => {
  for (let passed = 0; passed <= 55; passed++) {
    const { label, message } = badgeText('1.0.0', passed, 55)
    assert.equal(label, 'RFC 9309 vectors v1.0.0')
    assert.equal(message, `${passed} of 55`)
  }
  for (const [version, passed, total] of [['1.0', 1, 2], ['1.0.0', 3, 2], ['1.0.0', -1, 2], ['1.0.0', 1.5, 2], ['1.0.0', 0, 0]]) {
    assert.throws(() => badgeText(version, passed, total))
  }
})

test('isAllowed in this copy asks the matcher in src/robots.js', () => {
  const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/open\n'
  assert.equal(isAllowed(robots, 'ExampleBot', '/private/x'), false)
  assert.equal(isAllowed(robots, 'ExampleBot', '/private/open/y'), true)
  assert.equal(isAllowed(robots, 'ExampleBot', '/'), true)
})

test('the committed badge is one the script writes, and the README shows it with its own text', () => {
  const json = JSON.parse(read(`.github/badges/${JSON_FILE}`))
  const text = { label: json.label, message: json.message }
  const [, version] = /^RFC 9309 vectors v(\d+\.\d+\.\d+)$/.exec(text.label) ?? []
  const [, passed, total] = /^(\d+) of (\d+)$/.exec(text.message) ?? []
  assert.ok(version && passed && total, `${text.label} | ${text.message}`)
  assert.deepEqual(badgeText(version, Number(passed), Number(total)), text)
  assert.equal(read(`.github/badges/${SVG_FILE}`), badgeSvg(text))
  assert.equal(read(`.github/badges/${JSON_FILE}`), endpointJson(text))
  const img = `https://raw.githubusercontent.com/synapsereality/answer-crawler-check/main/.github/badges/${SVG_FILE}`
  assert.ok(read('README.md').includes(`[![${text.label}: ${text.message}](${img})](${PAGE_URL})`))
})
