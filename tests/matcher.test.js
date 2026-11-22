import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allows, matches, parseRobots } from '../src/robots.js'
import { matches as matches013 } from './fixtures/matches-0.1.3.js'

// A small seeded generator (mulberry32), so a failure can be run again.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const same = (pattern, path) => {
  const want = matches013(pattern, path)
  assert.equal(matches(pattern, path), want, `matches(${JSON.stringify(pattern)}, ${JSON.stringify(path)}) should be ${want}`)
  return want
}

/** Every string of length 0 to `max` over `chars`. */
function* strings(chars, max) {
  let level = ['']
  for (let n = 0; n <= max; n++) {
    yield* level
    level = level.flatMap((s) => [...chars].map((c) => s + c))
  }
}

test('every short pattern gives the answer the 0.1.3 matcher gives', () => {
  // 1,365 patterns over a, b, * and $ against 127 paths over a and b: 173,355 pairs.
  const paths = [...strings('ab', 6)]
  let pairs = 0
  let hits = 0
  for (const pattern of strings('ab*$', 5)) {
    for (const path of paths) {
      if (same(pattern, path)) hits++
      pairs++
    }
  }
  assert.equal(pairs, 1365 * 127)
  assert.ok(hits > pairs / 10 && hits < pairs - pairs / 10, `${hits} of ${pairs} matched`)
})

test('random patterns and near-miss paths give the answer the 0.1.3 matcher gives', () => {
  const next = rng(9309)
  const pick = (s) => s[Math.floor(next() * s.length)]
  const run = (chars, max) => Array.from({ length: Math.floor(next() * (max + 1)) }, () => pick(chars)).join('')
  const N = 100_000
  let hits = 0
  for (let i = 0; i < N; i++) {
    // A pattern of literal pieces and runs of `*`, often with a trailing `$`.
    // A `$` that is not last is a literal character, so some appear mid-pattern.
    let pattern = next() < 0.8 ? '/' : ''
    const pieces = 1 + Math.floor(next() * 5)
    for (let k = 0; k < pieces; k++) {
      pattern += run('ab/.%$', 4)
      if (k < pieces - 1 || next() < 0.3) pattern += '*'.repeat(1 + Math.floor(next() * 3))
    }
    if (next() < 0.4) pattern += '$'
    // A path built from the pattern, with each run of `*` filled, so it often
    // matches. Then, three times in four, one change: a character replaced, dropped
    // or added, or extra text at the end. A path may hold a literal `*` or `$`.
    let path = pattern.replace(/\$$/, '').replace(/\*+/g, () => run('ab/.*$', 6))
    if (next() < 0.75) {
      const at = Math.floor(next() * (path.length + 1))
      const change = Math.floor(next() * 4)
      if (change === 0 && at < path.length) path = path.slice(0, at) + pick('ab/*$') + path.slice(at + 1)
      else if (change === 1 && at < path.length) path = path.slice(0, at) + path.slice(at + 1)
      else if (change === 2) path = path.slice(0, at) + pick('ab/*$') + path.slice(at)
      else path += run('ab/', 3)
    }
    if (same(pattern, path)) hits++
  }
  assert.ok(hits > N / 5 && hits < N - N / 5, `${hits} of ${N} matched`)
})

test('long repeated pieces give the answer the 0.1.3 matcher gives', () => {
  const next = rng(2047)
  for (let i = 0; i < 2_000; i++) {
    const unit = ['a', 'ab', 'aab', 'aba'][i % 4]
    const reps = 1 + Math.floor(next() * 40)
    const piece = unit.repeat(reps)
    const tail = ['', 'b', 'a', 'c'][Math.floor(next() * 4)]
    const dollar = next() < 0.5 ? '$' : ''
    const pattern = `/*${piece}${tail}*${unit}${dollar}`
    const path = '/' + unit.repeat(reps + Math.floor(next() * 3) - 1) + (next() < 0.5 ? tail : '') + unit.repeat(Math.floor(next() * 3))
    same(pattern, path)
  }
})

test('random long pieces give the answer the 0.1.3 matcher gives', () => {
  // Pieces of 33 to 80 characters, past the length the matcher hands to
  // indexOf, over two letters so that partial matches overlap a lot.
  const next = rng(250)
  const run = (n) => Array.from({ length: n }, () => (next() < 0.7 ? 'a' : 'b')).join('')
  const N = 20_000
  let hits = 0
  for (let i = 0; i < N; i++) {
    const pieces = Array.from({ length: 1 + Math.floor(next() * 3) }, () => run(33 + Math.floor(next() * 48)))
    const dollar = next() < 0.4 ? '$' : ''
    const pattern = `/*${pieces.join('*')}${dollar}`
    let path = `/${pieces.map((p) => run(Math.floor(next() * 20)) + p).join('')}${next() < 0.5 ? run(Math.floor(next() * 5)) : ''}`
    if (next() < 0.6) {
      const at = 1 + Math.floor(next() * (path.length - 1))
      path = path.slice(0, at) + (path[at] === 'a' ? 'b' : 'a') + path.slice(at + 1)
    }
    if (same(pattern, path)) hits++
  }
  assert.ok(hits > N / 10 && hits < N - N / 10, `${hits} of ${N} matched`)
})

test('rules with long text after a wildcard are answered quickly', () => {
  // The slow case of 0.1.3: one `*`, then 2,046 letters that almost match the
  // path. 0.1.3 took 196 ms for one such rule and 87.6 s for the 254 that fit
  // in the 512 KiB the reader keeps. The new matcher took 12 to 17 ms for the
  // whole file in our runs, so the one-second bound is generous.
  const LONG = 2047
  const rule = `Disallow: /*${'a'.repeat(LONG - 2)}b`
  const rules = Math.floor((512 * 1024 - 14) / (rule.length + 1))
  assert.equal(rules, 254)
  const robots = parseRobots(`User-agent: *\n${Array(rules).fill(rule).join('\n')}\n`)
  assert.equal(robots.groups.get('*').length, 254)
  const path = `/${'a'.repeat(LONG - 1)}`
  const t = process.hrtime.bigint()
  assert.equal(allows(robots, 'ExampleBot', path).allowed, true)
  assert.equal(allows(robots, 'ExampleBot', `${path.slice(0, -1)}b`).allowed, false)
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.ok(ms < 1000, `two answers took ${ms.toFixed(1)} ms`)
})

test('other shapes that made 0.1.3 retry are answered quickly', () => {
  const LONG = 2047
  const path = `/${'a'.repeat(LONG - 1)}`
  const shapes = [
    `/*${'a'.repeat(LONG - 2)}b$`,
    `/*b${'a'.repeat(LONG - 3)}`,
    `/*${'a'.repeat(1000)}b*${'a'.repeat(1000)}`,
    `/*${`${'a'.repeat(30)}b`.repeat(60)}`,
    `/${'*a'.repeat(1000)}*b`,
    `/${'*'.repeat(10_000)}b`,
  ]
  const t = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) for (const s of shapes) assert.equal(matches(s, path), false, s.slice(0, 20))
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  assert.ok(ms < 1000, `${shapes.length * 20} matches took ${ms.toFixed(1)} ms`)
})

test('a piece longer than 250 characters is found in time linear in the path', () => {
  // V8's indexOf slows to piece length times path length on a piece like this,
  // which is why the matcher has its own search. Each file is 512 KiB of one
  // rule. At 0.1.3 the first took 0.6 s, and with indexOf the last took 0.8 s.
  const times = []
  for (const [pathLength, pieceLength] of [[2048, 606], [4096, 1206], [8192, 2406]]) {
    const rule = `Disallow: /*aaaaab${'a'.repeat(pieceLength - 6)}`
    const rules = Math.floor((512 * 1024 - 14) / (rule.length + 1))
    const robots = parseRobots(`User-agent: *\n${Array(rules).fill(rule).join('\n')}\n`)
    const path = `/${'a'.repeat(pathLength - 1)}`
    const t = process.hrtime.bigint()
    assert.equal(allows(robots, 'ExampleBot', path).allowed, true)
    assert.equal(allows(robots, 'ExampleBot', `/aaaaab${path.slice(1)}`).allowed, false)
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  assert.ok(times.every((ms) => ms < 1000), `${times.map((ms) => ms.toFixed(1)).join(', ')} ms`)
})

test('the pieces of one rule are found in order, each after the last', () => {
  assert.equal(matches('/*ab*ab$', '/abab'), true)
  assert.equal(matches('/*ab*ab$', '/aba'), false)
  assert.equal(matches('/*aaa*aaa', '/aaaaa'), false)
  assert.equal(matches('/*aaa*aaa', '/aaaaaa'), true)
  const long = 'ab'.repeat(40)
  assert.equal(matches(`/*${long}*${long}$`, `/x${long}${long}`), true)
  assert.equal(matches(`/*${long}*${long}$`, `/x${long}${long.slice(1)}`), false)
  assert.equal(matches(`/*${long}c`, `/${long}${long}c`), true)
})

test('the work on a path grows with its length, not with piece length times it', () => {
  // The timing tests above can pass on a fast machine with a slow search, so
  // this counts the work instead. The path is an object that charges each call
  // by the characters it may have to compare: one per charCodeAt, the needle
  // for startsWith and endsWith, and the needle times what is left for indexOf.
  const counted = (s) => {
    let work = 0
    const path = {
      length: s.length,
      charCodeAt: (i) => { work++; return s.charCodeAt(i) },
      startsWith: (x, at) => { work += x.length; return s.startsWith(x, at) },
      endsWith: (x) => { work += x.length; return s.endsWith(x) },
      indexOf: (x, at = 0) => { work += x.length * Math.max(1, s.length - at); return s.indexOf(x, at) },
    }
    return { path, work: () => work }
  }
  const cases = [
    [`/*aaaaab${'a'.repeat(600)}`, `/${'a'.repeat(8191)}`, false],
    [`/*${'a'.repeat(2045)}b`, `/${'a'.repeat(2046)}`, false],
    [`/*${'a'.repeat(32)}b*${'a'.repeat(33)}$`, `/${'a'.repeat(2000)}b${'a'.repeat(2000)}`, true],
    [`/*${'ab'.repeat(200)}c`, `/${'ab'.repeat(4000)}`, false],
    [`/x*${'a'.repeat(33)}`, `/x${'a'.repeat(5000)}`, true],
  ]
  for (const [pattern, text, want] of cases) {
    const { path, work } = counted(text)
    assert.equal(matches(pattern, path), want, pattern.slice(0, 20))
    assert.ok(work() <= 2 * (pattern.length + text.length) + 32 * text.length, `${pattern.slice(0, 20)}: ${work()} for a path of ${text.length}`)
  }
})
