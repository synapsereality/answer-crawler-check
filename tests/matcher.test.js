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

test('rules with long text after a wildcard are answered quickly', () => {
  // The slow case of 0.1.3: one `*`, then 2,045 letters that almost match the
  // path. 0.1.3 took 196 ms for one such rule and 87.6 s for the 254 that fit
  // in the 512 KiB the reader keeps. The new matcher takes about a millisecond
  // for the whole file, so the one-second bound is generous.
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
