# Changelog

Releases before 0.1.4 are described on the
[GitHub releases page](https://github.com/synapsereality/answer-crawler-check/releases).

## 0.1.4, not released yet

### Faster matching of rules with a wildcard

A rule with a `*` followed by a long piece of text was slow to check. The
matcher walked the rule and the path side by side. On a mismatch it went back
to the last `*` and tried again one character further on. So the work grew with
the length of the text after the `*` times the length of the path, for each
rule. A robots.txt built this way, on purpose or by mistake, could hold up a CI
job for minutes.

We timed `allows()` on Node 22.23.5, on a virtual machine with 8 vCPUs. The
rule was `/*`, then 2,045 letters `a` and a `b`. The path was a slash and 2,046
letters `a`. The same file is a test in `tests/matcher.test.js` now.

| Case | 0.1.3 | 0.1.4 |
|---|---|---|
| That one rule, median of 21 runs | 196 ms | 0.29 ms |
| 254 such rules, as many as fit in 512 KiB, median of 3 runs | 87.6 s | 16.0 ms |

The matcher now takes the pieces between runs of `*` in order. The first piece
must start the path. Each later piece is searched for from where the one before
it ended. With a trailing `$`, the last piece must end the path. A search for
a piece longer than 32 characters uses Knuth-Morris-Pratt, which reads each
character of the path once. String `indexOf` is kept for short pieces only.
On some pieces longer than about 250 characters, V8's `indexOf` slows to piece
length times path length. So the time for a rule now grows with its length plus
the path's.

The answers are the same. A new test compares the new matcher with the 0.1.3
one on 295,355 generated pairs of patterns and paths. The existing tests and
the RFC 9309 test vectors pass unchanged.
