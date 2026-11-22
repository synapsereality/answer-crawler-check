// The matcher of release 0.1.3, lines 98 to 139 of its src/robots.js, kept
// unchanged so tests/matcher.test.js can check that the new matcher gives the
// same answers. It walks the rule and the path side by side. On a mismatch it
// goes back to the last `*` and tries again one character further on. That is
// correct, but slow when a long piece of text follows a `*`.

/**
 * Does `pattern` match `path`? `*` matches any run of characters and a
 * trailing `$` anchors the end; otherwise a pattern is a prefix. Written as a
 * two-pointer walk, which cannot backtrack exponentially on a hostile file.
 */
export function matches(pattern, path) {
  let p = pattern
  const anchored = p.endsWith('$')
  if (anchored) p = p.slice(0, -1)
  else p += '*'
  let pi = 0
  let si = 0
  let star = -1
  let starS = 0
  for (;;) {
    if (pi === p.length) {
      if (!anchored || si === path.length) return true
      if (star >= 0 && starS < path.length) {
        starS++
        si = starS
        pi = star + 1
        continue
      }
      return false
    }
    const ch = p[pi]
    if (ch === '*') {
      star = pi
      starS = si
      pi++
    } else if (si < path.length && ch === path[si]) {
      pi++
      si++
    } else if (star >= 0 && starS < path.length) {
      starS++
      si = starS
      pi = star + 1
    } else {
      return false
    }
  }
}
