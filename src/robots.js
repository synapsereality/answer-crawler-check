// A small robots.txt reader: User-agent groups, Allow, Disallow, Sitemap.
// Group choice and rule precedence follow RFC 9309 (the Robots Exclusion
// Protocol), which is also what Google documents: a crawler obeys the group
// that names its product token, else the `*` group; inside a group the longest
// matching pattern wins, and Allow wins a tie.

// RFC 9309 asks parsers to read at least 500 KiB. Past that we stop and say so,
// because a partial file that happens to miss a Disallow reads like permission.
export const MAX_BYTES = 512 * 1024
const MAX_RULES = 20_000

/**
 * @typedef {{allow: boolean, pattern: string, line: number}} Rule
 * @typedef {{groups: Map<string, Rule[]>, sitemaps: string[], truncated: boolean}} Robots
 */

/** The product token of a User-agent value, lower-cased: `GPTBot/1.1 (+https://...)` -> `gptbot`. */
export function agentToken(value) {
  const v = value.trim()
  if (v.startsWith('*')) return '*'
  const m = /^[^\s/;(]+/.exec(v)
  return (m ? m[0] : v).toLowerCase()
}

/**
 * One spelling per path, so `/über` and `/%c3%bcber` compare equal: non-ASCII is
 * percent-encoded as UTF-8 and existing escapes get upper-case hex.
 */
export function normPath(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out += '%' + s.slice(i + 1, i + 3).toUpperCase()
      i += 2
    } else if (ch.charCodeAt(0) < 128) {
      out += ch
    } else {
      const cp = s.codePointAt(i)
      const chars = String.fromCodePoint(cp)
      for (const b of Buffer.from(chars, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
      i += chars.length - 1
    }
  }
  return out
}

/** @returns {Robots} */
export function parseRobots(text) {
  const robots = { groups: new Map(), sitemaps: [], truncated: false }
  let body = text ?? ''
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, MAX_BYTES).toString('utf8')
    robots.truncated = true
  }
  // A UTF-8 byte order mark would otherwise glue itself to the first key.
  const lines = body.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  let current = []
  let lastWasAgent = false
  let count = 0
  lines.forEach((raw, idx) => {
    const line = raw.split('#', 1)[0].trim()
    const colon = line.indexOf(':')
    if (!line || colon < 0) return
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!lastWasAgent) current = []
      const agent = agentToken(value)
      current.push(agent)
      if (!robots.groups.has(agent)) robots.groups.set(agent, [])
      lastWasAgent = true
      return
    }
    if (key === 'sitemap') {
      // Not a group member, so it does not end a run of User-agent lines.
      if (value) robots.sitemaps.push(value)
      return
    }
    lastWasAgent = false
    if ((key === 'allow' || key === 'disallow') && current.length) {
      if (count >= MAX_RULES) {
        robots.truncated = true
        return
      }
      count++
      // `Disallow:` with no value allows everything, which is the same as no rule.
      if (key === 'disallow' && value === '') return
      for (const agent of current) {
        robots.groups.get(agent).push({ allow: key === 'allow', pattern: normPath(value), line: idx + 1 })
      }
    }
  })
  return robots
}

/**
 * Does `pattern` match `path`? `*` matches any run of characters and a
 * trailing `$` anchors the end; otherwise a pattern is a prefix.
 *
 * The pieces between runs of `*` are matched in order. The first piece must
 * start the path. Each later piece is searched for from where the one before
 * it ended, and the leftmost place is always a safe choice, because the `*`
 * before the next piece can take up any gap. With `$` the last piece must end
 * the path, at or after that point. Each search reads the path forward from
 * there, so a rule costs time in proportion to its length plus the path's.
 */
export function matches(pattern, path) {
  const anchored = pattern.endsWith('$')
  const end = anchored ? pattern.length - 1 : pattern.length
  // The rule is read forward, one piece at a time, so a piece that is not
  // there ends the match before the rest of the rule is looked at.
  let i = 0
  for (; i < end; i++) {
    const c = pattern.charCodeAt(i)
    if (c === 42) break
    if (c !== path.charCodeAt(i)) return false
  }
  if (i === end) return !anchored || path.length === end
  let at = i
  for (;;) {
    while (i < end && pattern.charCodeAt(i) === 42) i++
    if (i === end) return true
    const j = pattern.indexOf('*', i)
    if (j < 0) {
      // The last piece. With `$` it must end the path, at or after `at`.
      if (anchored) return path.length - (end - i) >= at && path.endsWith(pattern.slice(i, end))
      return find(pattern, i, end, path, at) >= 0
    }
    const found = find(pattern, i, j, path, at)
    if (found < 0) return false
    at = found + (j - i)
    i = j
  }
}

// A piece this short goes to indexOf. Even a naive search then costs at most
// SHORT character checks per path character.
const SHORT = 32

/**
 * Where `pattern.slice(from, to)` first occurs in `path` at or after `start`,
 * or -1. A longer piece is searched for with Knuth-Morris-Pratt, which reads
 * each character of the path once. String indexOf is not used for it: in V8,
 * some pieces longer than about 250 characters make it slow to piece length
 * times path length.
 */
function find(pattern, from, to, path, start) {
  const m = to - from
  if (path.length - start < m) return -1
  if (m <= SHORT) return path.indexOf(pattern.slice(from, to), start)
  const back = new Int32Array(m)
  for (let q = 1, k = 0; q < m; q++) {
    const c = pattern.charCodeAt(from + q)
    while (k > 0 && c !== pattern.charCodeAt(from + k)) k = back[k - 1]
    if (c === pattern.charCodeAt(from + k)) k++
    back[q] = k
  }
  for (let s = start, k = 0; s < path.length; s++) {
    const c = path.charCodeAt(s)
    while (k > 0 && c !== pattern.charCodeAt(from + k)) k = back[k - 1]
    if (c === pattern.charCodeAt(from + k) && ++k === m) return s - m + 1
  }
  return -1
}

/**
 * Is `agent` allowed to fetch `path` (path plus query)?
 * @returns {{allowed: boolean, group: string|null, rule: Rule|null}}
 */
export function allows(robots, agent, path) {
  const token = agentToken(agent)
  let group = token
  let rules = robots.groups.get(token)
  if (rules === undefined) {
    group = '*'
    rules = robots.groups.get('*')
  }
  if (rules === undefined) return { allowed: true, group: null, rule: null }
  // RFC 9309 section 2.2.2: /robots.txt itself is always allowed.
  if (path === '/robots.txt') return { allowed: true, group, rule: null }
  const target = normPath(path || '/')
  let best = null
  for (const r of rules) {
    if (!matches(r.pattern, target)) continue
    // Length is counted on the pattern as written, `*` and `$` included, as Google does.
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
      best = r
    }
  }
  return { allowed: best ? best.allow : true, group, rule: best }
}

/** Does any group name this agent, as opposed to it falling through to `*`? */
export function names(robots, agent) {
  return robots.groups.has(agentToken(agent))
}
