// rfc9309-vectors-badge.mjs, for Node 20 or later, with no dependencies.
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Synapse Research Ltd
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
//   node rfc9309-vectors-badge.mjs [--out DIR] [--known ID,ID] [--vectors FILE|URL] [--check]
//
//   --out DIR           where the two files go (default: the current folder)
//   --known ID,ID       vectors your parser reads another way on purpose. They
//                       still count as misses on the badge, and the run passes.
//   --vectors FILE|URL  read the vectors from here instead of the URL below
//   --check             write nothing, and fail if the files in DIR differ
//                       from what this run would write
//
// Exit code 0 when every vector gives the expected result, apart from the
// --known ones. 1 when another vector gives the other result, or --check finds
// a file out of date. The files are still written in the first case. 2 for a
// bad flag, a vectors file that can't be read, or an isAllowed that fails on
// every vector. Nothing is written then.
//
// The badge states a count and the version of the vectors file, nothing more.
// The script fetches the vectors file once and calls nothing else.

import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { allows, parseRobots } from '../src/robots.js'

// Your parser goes here. It gets the whole robots.txt file, the crawler name
// and the path, and returns true when that crawler may fetch that path. It may
// be async. Change the one line inside it.
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
const USAGE = 'usage: node rfc9309-vectors-badge.mjs [--out DIR] [--known ID,ID] [--vectors FILE|URL] [--check]'

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
    const whole = v !== null && typeof v === 'object' && typeof v.id === 'string' && v.id !== '' &&
      typeof v.robots_txt === 'string' && typeof v.user_agent === 'string' && typeof v.path === 'string' &&
      (v.expected === 'allowed' || v.expected === 'disallowed')
    if (!whole) throw new Error(`vector ${i + 1} needs an id, robots_txt, user_agent, path and expected`)
    if (ids.has(v.id)) throw new Error(`the id ${v.id} is used twice`)
    ids.add(v.id)
  })
  return { version: data.version, vectors: data.vectors }
}

/**
 * Runs every vector through the parser. A vector counts when the parser gives
 * the expected result. An answer that is not true or false, or an error, is a miss.
 */
export async function measure(vectors, parser) {
  const missed = []
  let errors = 0
  for (const v of vectors) {
    let answer
    try {
      answer = await parser(v.robots_txt, v.user_agent, v.path)
      if (typeof answer !== 'boolean') throw new Error(`isAllowed returned ${answer === null ? 'null' : typeof answer}, not true or false`)
    } catch (err) {
      errors++
      missed.push({ id: v.id, expected: v.expected, error: err instanceof Error ? err.message : String(err) })
      continue
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
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/

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

async function load(source) {
  let url = null
  try {
    url = new URL(source)
  } catch {
    // Not a URL, so a file path.
  }
  if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`${url.href} answered ${res.status}`)
    return await res.json()
  }
  return JSON.parse(await readFile(url && url.protocol === 'file:' ? url : source, 'utf8'))
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
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (err) {
    io.err(`${err.message}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    io.out(USAGE)
    return 0
  }
  const known = new Set(args.known.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean))

  let file
  try {
    file = readVectors(await load(args.vectors))
  } catch (err) {
    io.err(`rfc9309-vectors-badge: could not read the vectors from ${args.vectors}: ${err.message}`)
    return 2
  }

  const result = await measure(file.vectors, parser)
  if (result.errors === result.total) {
    io.err(`rfc9309-vectors-badge: isAllowed failed on every vector, so no badge was written. The first error: ${result.missed[0].error}`)
    return 2
  }
  const ids = new Set(file.vectors.map((v) => v.id))
  for (const id of known) if (!ids.has(id)) io.err(`--known ${id}: no vector in version ${file.version} has this id`)
  let unexpected = 0
  for (const m of result.missed) {
    if (!known.has(m.id)) unexpected++
    const what = m.error === undefined ? `expected ${m.expected}, got ${m.got}` : `isAllowed failed: ${m.error}`
    io.out(`${m.id}: ${what}${known.has(m.id) ? ' (known)' : ''}`)
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
    const stale = []
    for (const [path, body] of files) {
      let current = null
      try {
        current = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
      } catch {
        // A missing file is out of date too.
      }
      if (current !== body) stale.push(path)
    }
    if (stale.length) {
      io.err(`out of date: ${stale.join(' and ')}. Run without --check to write the badge for this result.`)
      return 1
    }
    io.out(`${files.map(([path]) => path).join(' and ')} match this run`)
  } else {
    try {
      await mkdir(args.out, { recursive: true })
      for (const [path, body] of files) await writeFile(path, body)
    } catch (err) {
      io.err(`rfc9309-vectors-badge: could not write the badge: ${err.message}`)
      return 2
    }
    io.out(`wrote ${files.map(([path]) => path).join(' and ')}`)
  }
  return unexpected ? 1 : 0
}

/** True when Node runs this file, false when another module imports it. */
function runDirectly() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (runDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(err)
      process.exitCode = 2
    },
  )
}
