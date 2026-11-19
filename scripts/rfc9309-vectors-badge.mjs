// rfc9309-vectors-badge.mjs, for Node 20 or later, with no dependencies.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Synapse Research Ltd. The licence text is at the end.
// https://synapsereality.io/open-source/answer-crawler-check/rfc9309-test-vectors/
//
// Runs the RFC 9309 robots.txt test vectors against your parser and writes a
// badge with the count it measured, as two files:
//
//   rfc9309-vectors-badge.svg   a static badge: RFC 9309 vectors v1.0.0 | 52 of 55
//   rfc9309-vectors-badge.json  the same text, for a shields.io endpoint badge
//
// This copy runs the vectors against this repo's own matcher, src/robots.js,
// and the rfc9309-vectors CI job runs it with --check. The script it was
// copied from, with an empty isAllowed(), is served at
// https://synapsereality.io/open-source/answer-crawler-check/rfc9309-vectors-badge.mjs
//
// Run:
//
//   node rfc9309-vectors-badge.mjs [--out DIR] [--known ID,ID] [--vectors FILE|URL] [--check] [--timeout S]
//
//   --out DIR           where the two files go (default: the current folder)
//   --known ID,ID       vectors your parser reads another way on purpose. They
//                       still count as misses on the badge, and the run passes.
//                       An error on one of them still fails the run.
//   --vectors FILE|URL  read the vectors from here instead of the URL below
//   --check             write nothing, and fail if the files in DIR differ
//                       from what this run would write. A badge that names an
//                       older patch release, with the same count, still passes.
//   --timeout S         seconds to wait for one answer from isAllowed (default 60)
//
// Exit codes:
//   0  Every vector gives the expected result, apart from the --known ones.
//   1  Another vector gives the other result. Or isAllowed fails, or answers
//      something other than true or false, on some vectors. Or --check finds
//      a file out of date. Without --check the files are still written.
//   2  A bad flag or a vectors file that can't be read. Or isAllowed fails on
//      every vector, or gives no answer within --timeout. Nothing is written in
//      these cases. Also a file that can't be written: each file is replaced
//      whole or not at all.
//
// The badge states a count and the version of the vectors file, nothing more.
// The script fetches the vectors file, once more if that fails, and calls
// nothing else.

import { realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { allows, parseRobots } from '../src/robots.js'

// Your parser goes here. It gets the whole robots.txt file, the crawler name
// and the path, and returns true when that crawler may fetch that path. It may
// be async. Replace the line inside, and import your parser at the top.
export function isAllowed(robotsTxt, userAgent, path) {
  return allows(parseRobots(robotsTxt), userAgent, path).allowed
}

export const VECTORS_URL = 'https://synapsereality.io/open-source/answer-crawler-check/rfc9309-test-vectors.json'
export const PAGE_URL = 'https://synapsereality.io/open-source/answer-crawler-check/rfc9309-test-vectors/'
export const SCRIPT_URL = 'https://synapsereality.io/open-source/answer-crawler-check/rfc9309-vectors-badge.mjs'
export const SVG_FILE = 'rfc9309-vectors-badge.svg'
export const JSON_FILE = 'rfc9309-vectors-badge.json'
/** The first number of the vectors version this script reads. A new one means a new copy of the script. */
export const MAJOR = 1

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
// Ids are printed at the start of a line, where a newline or an escape could
// pass for a CI command, so they are held to the form the vectors use.
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const USAGE = 'usage: node rfc9309-vectors-badge.mjs [--out DIR] [--known ID,ID] [--vectors FILE|URL] [--check] [--timeout S]'
// The vectors file is under 100 KB. Anything far larger is not it.
const MAX_BYTES = 5 * 1024 * 1024

/** Text on one line, so nothing printed can start a line of its own. */
const oneLine = (text) => String(text).replace(/[\u0000-\u001F\u007F]+/g, ' ')

/** The message of anything thrown, even a value that cannot be turned into a string. */
function messageOf(err) {
  try {
    return oneLine(err instanceof Error ? err.message : String(err))
  } catch {
    return 'a value that cannot be printed'
  }
}

/** Thrown when isAllowed gives no answer in time. It stops the run. */
export class NoAnswer extends Error {}

/**
 * Checks the parsed vectors file and returns its version and vectors.
 * @param {unknown} data
 * @returns {{version: string, vectors: {id: string, robots_txt: string, user_agent: string, path: string, expected: 'allowed' | 'disallowed'}[]}}
 */
export function readVectors(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('the vectors file is not a JSON object')
  const match = typeof data.version === 'string' ? VERSION.exec(data.version) : null
  if (!match) throw new Error('the vectors file has no version such as 1.0.0')
  if (Number(match[1]) !== MAJOR) {
    throw new Error(`this script reads version ${MAJOR} of the vectors and the file is version ${data.version}. Get the current script from ${SCRIPT_URL}`)
  }
  if (!Array.isArray(data.vectors) || data.vectors.length === 0) throw new Error('the vectors file holds no vectors')
  const ids = new Set()
  data.vectors.forEach((v, i) => {
    const whole = v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id.length <= 100 && ID.test(v.id) &&
      typeof v.robots_txt === 'string' && typeof v.user_agent === 'string' && typeof v.path === 'string' &&
      (v.expected === 'allowed' || v.expected === 'disallowed')
    if (!whole) throw new Error(`vector ${i + 1} needs an id of lower-case letters, digits and hyphens, a robots_txt, user_agent, path and expected`)
    if (ids.has(v.id)) throw new Error(`the id ${v.id} is used twice`)
    ids.add(v.id)
  })
  return { version: data.version, vectors: data.vectors }
}

/**
 * Runs every vector through the parser. A vector counts when the parser gives
 * the expected result. An answer that is not true or false, or an error, is a
 * miss. No answer within timeoutMs throws NoAnswer and stops the run.
 */
export async function measure(vectors, parser, timeoutMs = 60_000) {
  const missed = []
  let errors = 0
  for (const v of vectors) {
    let answer
    let timer
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new NoAnswer(`isAllowed gave no answer for ${v.id} within ${timeoutMs / 1000} s`)), timeoutMs)
    })
    try {
      answer = await Promise.race([Promise.resolve().then(() => parser(v.robots_txt, v.user_agent, v.path)), late])
      if (typeof answer !== 'boolean') throw new Error(`isAllowed returned ${answer === null ? 'null' : typeof answer}, not true or false`)
    } catch (err) {
      if (err instanceof NoAnswer) throw err
      errors++
      missed.push({ id: v.id, expected: v.expected, error: messageOf(err) })
      continue
    } finally {
      clearTimeout(timer)
    }
    const got = answer ? 'allowed' : 'disallowed'
    if (got !== v.expected) missed.push({ id: v.id, expected: v.expected, got })
  }
  return { passed: vectors.length - missed.length, total: vectors.length, missed, errors }
}

/** The two halves of the badge. Nothing but the version and the count goes in. */
export function badgeText(version, passed, total) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error(`not a version: ${version}`)
  if (!Number.isInteger(total) || !Number.isInteger(passed) || total < 1 || passed < 0 || passed > total) {
    throw new Error(`not a count: ${passed} of ${total}`)
  }
  return { label: `RFC 9309 vectors v${version}`, message: `${passed} of ${total}` }
}

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// Characters XML 1.0 does not allow at all, so no escape can carry them.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/

/** Text for an SVG element or attribute, escaped in one pass. */
export function escapeXml(text) {
  const s = String(text)
  if (NOT_XML.test(s)) throw new Error('the badge text holds a character XML cannot carry')
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c])
}

// An 11px monospace glyph is about 0.6em wide. textLength holds each line to
// that width whatever monospace font the viewer has.
const GLYPH = 6.6
const PAD = 6
const HEIGHT = 20
const FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace"

/** Sizes of the badge, in pixels. */
export function badgeLayout({ label, message }) {
  const labelText = Math.round([...label].length * GLYPH)
  const messageText = Math.round([...message].length * GLYPH)
  const labelWidth = labelText + 2 * PAD
  const messageWidth = messageText + 2 * PAD
  return { width: labelWidth + messageWidth, height: HEIGHT, labelWidth, messageWidth, labelText, messageText }
}

/** The static SVG badge: square corners, no gradient, the same bytes for the same count. */
export function badgeSvg(text) {
  const { width, height, labelWidth, messageWidth, labelText, messageText } = badgeLayout(text)
  const title = escapeXml(`${text.label}: ${text.message}`)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
    `  <title>${title}</title>`,
    `  <rect width="${labelWidth}" height="${height}" fill="#27272a"/>`,
    `  <rect x="${labelWidth}" width="${messageWidth}" height="${height}" fill="#090a0c"/>`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#3f3f46"/>`,
    `  <g font-family="${FONT}" font-size="11" text-anchor="middle">`,
    `    <text x="${labelWidth / 2}" y="14" fill="#ededed" textLength="${labelText}" lengthAdjust="spacingAndGlyphs">${escapeXml(text.label)}</text>`,
    `    <text x="${labelWidth + messageWidth / 2}" y="14" fill="#10b981" textLength="${messageText}" lengthAdjust="spacingAndGlyphs">${escapeXml(text.message)}</text>`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}

/** The same text for https://shields.io/badges/endpoint-badge. */
export function endpointJson({ label, message }) {
  const badge = { schemaVersion: 1, label, message, labelColor: '27272a', color: '090a0c', style: 'flat-square' }
  return `${JSON.stringify(badge, null, 2)}\n`
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

/** An answer the server gave on purpose, such as a 404. Asking again would not change it. */
class Refused extends Error {}

/** The body of a response, refused past MAX_BYTES before it is all in memory. */
async function bodyText(res, url) {
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > MAX_BYTES) throw new Refused(`${url.href} sent more than ${MAX_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One retry after a network error, a 5xx or a 429, so a blip does not fail a CI run. */
async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      if (res.ok) return await bodyText(res, url)
      if (attempt < 2 && (res.status >= 500 || res.status === 429)) {
        await pause(2_000)
        continue
      }
      throw new Refused(`${url.href} answered ${res.status}`)
    } catch (err) {
      if (err instanceof Refused) throw err
      // A network error, a timeout or a body cut off halfway: ask once more.
      if (attempt < 2) {
        await pause(2_000)
        continue
      }
      throw new Error(`${url.href} did not answer: ${messageOf(err.cause ?? err)}`)
    }
  }
}

/** A regular file, read only when it is one and is not oversized. A pipe or a device is refused. */
async function readSmallFile(path) {
  const st = await stat(path)
  if (!st.isFile()) throw new Error(`${path} is not a file`)
  if (st.size > MAX_BYTES) throw new Error(`${path} is over ${MAX_BYTES} bytes`)
  return await readFile(path, 'utf8')
}

async function load(source) {
  let url = null
  try {
    url = new URL(source)
  } catch {
    // Not a URL, so a file path.
  }
  if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return JSON.parse(await fetchText(url))
  return JSON.parse(await readSmallFile(url && url.protocol === 'file:' ? fileURLToPath(url) : source))
}

/** The version a badge JSON file names in its label, or null. */
function namedVersion(json) {
  try {
    const match = /^RFC 9309 vectors v(\d+\.\d+\.\d+)$/.exec(JSON.parse(json).label)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Replaces each file whole: both go to new temporary files first, then each is
 * renamed over its target, so a failed write never leaves half a file. The
 * temporary names are random and created exclusively, so an existing file or
 * link at one of them is never written through.
 */
async function writeWhole(dir, files) {
  await mkdir(dir, { recursive: true })
  for (const [path] of files) {
    const st = await stat(path).catch(() => null)
    if (st && !st.isFile()) throw new Error(`${path} is not a file`)
  }
  const made = []
  try {
    for (const [path, body] of files) {
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temp, body, { flag: 'wx' })
      made.push([temp, path])
    }
    for (const [temp, path] of made) await rename(temp, path)
  } finally {
    await Promise.all(made.map(([temp]) => rm(temp, { force: true })))
  }
}

/**
 * The command line. Returns the exit code.
 * @param {string[]} argv
 * @param {(robotsTxt: string, userAgent: string, path: string) => boolean | Promise<boolean>} parser
 */
export async function main(argv = process.argv.slice(2), parser = isAllowed, io = { out: console.log, err: console.error }) {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
        out: { type: 'string', default: '.' },
        known: { type: 'string', multiple: true, default: [] },
        vectors: { type: 'string', default: VECTORS_URL },
        check: { type: 'boolean', default: false },
        timeout: { type: 'string', default: '60' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (err) {
    io.err(`${messageOf(err)}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    io.out(USAGE)
    return 0
  }
  const seconds = Number(args.timeout)
  if (!/^\d+(\.\d+)?$/.test(args.timeout) || !(seconds > 0) || seconds > 3600) {
    io.err(`--timeout takes a number of seconds from above 0 up to 3600\n${USAGE}`)
    return 2
  }
  const known = new Set(args.known.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean))

  let file
  try {
    file = readVectors(await load(args.vectors))
  } catch (err) {
    io.err(`rfc9309-vectors-badge: could not read the vectors from ${oneLine(args.vectors)}: ${messageOf(err)}`)
    return 2
  }

  let result
  try {
    result = await measure(file.vectors, parser, seconds * 1000)
  } catch (err) {
    if (!(err instanceof NoAnswer)) throw err
    io.err(`rfc9309-vectors-badge: ${err.message}, so no badge was written. Is isAllowed waiting on something that never comes?`)
    return 2
  }
  if (result.errors === result.total) {
    io.err(`rfc9309-vectors-badge: isAllowed failed on every vector, so no badge was written. The first error: ${result.missed[0].error}`)
    return 2
  }
  const ids = new Set(file.vectors.map((v) => v.id))
  for (const id of known) if (!ids.has(id)) io.err(`--known ${oneLine(id)}: no vector in version ${file.version} has this id`)
  let unexpected = 0
  for (const m of result.missed) {
    // --known is for a different reading of the RFC, never for a parser that fails.
    const listed = known.has(m.id) && m.error === undefined
    if (!listed) unexpected++
    const what = m.error === undefined ? `expected ${m.expected}, got ${m.got}` : `isAllowed failed: ${m.error}`
    io.out(`${m.id}: ${what}${listed ? ' (known)' : ''}`)
  }
  const missedIds = new Set(result.missed.map((m) => m.id))
  for (const id of known) if (ids.has(id) && !missedIds.has(id)) io.out(`${id}: now gives the expected result, so it can come off --known`)

  const text = badgeText(file.version, result.passed, result.total)
  io.out(`${text.message} as expected, ${text.label}`)
  const files = [
    [join(args.out, SVG_FILE), badgeSvg(text)],
    [join(args.out, JSON_FILE), endpointJson(text)],
  ]
  if (args.check) {
    const current = []
    for (const [path] of files) {
      try {
        current.push((await readSmallFile(path)).replace(/\r\n/g, '\n'))
      } catch {
        current.push(null) // A missing file, or anything but a file, is out of date too.
      }
    }
    const same = (bodies) => bodies.every((body, i) => current[i] === body)
    if (same(files.map(([, body]) => body))) {
      io.out(`${files.map(([path]) => path).join(' and ')} match this run`)
    } else {
      // A new last number fixes a reason or a quote and changes no result.
      // A badge that names an older patch with the same count still holds.
      const named = current[1] === null ? null : namedVersion(current[1])
      const [was, now] = [named ?? '', file.version].map((v) => v.split('.').map(Number))
      const olderPatch = named !== null && was[0] === now[0] && was[1] === now[1] && was[2] < now[2]
      const old = olderPatch ? badgeText(named, result.passed, result.total) : null
      if (old && same([badgeSvg(old), endpointJson(old)])) {
        io.out(`the badge names vectors ${named} and this run read ${file.version}, with the same count. Run without --check to update its label.`)
      } else {
        const stale = files.filter((f, i) => current[i] !== f[1]).map(([path]) => oneLine(path))
        io.err(`out of date: ${stale.join(' and ')}. Run without --check to write the badge for this result.`)
        return 1
      }
    }
  } else {
    try {
      await writeWhole(args.out, files)
    } catch (err) {
      io.err(`rfc9309-vectors-badge: could not write the badge: ${messageOf(err)}`)
      return 2
    }
    io.out(`wrote ${files.map(([path]) => path).join(' and ')}`)
  }
  return unexpected ? 1 : 0
}

/** True when Node runs this file, false when another module imports it. */
function runDirectly() {
  try {
    return process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (runDirectly()) {
  // Only a finished run lowers this. A promise from isAllowed that never
  // settles lets Node exit with nothing left to do, and that must not pass.
  let finished = false
  process.exitCode = 2
  process.on('exit', () => {
    if (!finished) console.error('rfc9309-vectors-badge: the run stopped before it finished. Does isAllowed return a promise that never settles?')
  })
  // A parser that gave up may still hold a timer or a child process open. Once
  // the run is over, a second is enough to flush the output, then Node exits.
  const done = (code) => {
    finished = true
    process.exitCode = code
    setTimeout(() => process.exit(code), 1_000).unref()
  }
  main().then(done, (err) => {
    console.error(err)
    done(2)
  })
}

/*
MIT License

Copyright (c) 2026 Synapse Research Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
