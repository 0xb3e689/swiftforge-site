# swiftforge-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/0xb3e689/swiftforge-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/0xb3e689/swiftforge-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Swiftforge is a drop-in fast build for makefun-site 1.0.0: `run(input)` in `solve.js` returns the exact output
tree of makefun-site's `build(input)` — every page's `index.html`, the index, tag and tags pages, each static
file and `build-report.txt`, byte for byte — computed with hand-written single-pass character scanners in place
of the reference's per-line and per-character regexes. `main.ts` is the driver the harness runs: it reads every
case from `/input/cases.json`, answers each with one independent `run(input)` call, and writes
`/output/answers.json`. No dependencies, no WebAssembly, no state kept across cases.

## Run it

```sh
node main.ts
```

(MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output outside the grading container.)

---

<sub>Entered on [make.fun](https://make.fun/?ref=93p1fwth&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
