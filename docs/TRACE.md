# ETW performance trace (optional)

`trace_d365fo` measures where a slow D365FO process spends its time — which X++ methods, which SQL
statements, which callers run the same query thousands of times — without changing the
application. It replaces the usual approach of an agent adding timer classes, CoC wrappers or
`info()` calls around suspect methods, rebuilding, running, and removing them again.

It captures the AOS's own ETW events (the same ones Trace Parser reads) with `logman`, and
analyses the `.etl` file in the bridge binary. Trace Parser is not needed.

## Requirements

- A D365FO development VM with its local AOS (Windows).
- MCP running under an account allowed to start ETW sessions: a member of **Administrators** or
  **Performance Log Users**. Otherwise `start` answers `TRACE_ACCESS_DENIED`.
- The bridge built from these sources (`dotnet build bridge/D365MetadataBridge -c Release`): the
  analysis runs as `D365MetadataBridge.exe --analyze-trace` in its own process.
- Disk space: a capture grows by roughly 2 MB/s on an idle AOS and **40–50 MB/s** under a busy
  batch job. A 60-second capture of a heavy job can take 3 GB.

## Setup

```bash
npx tsx src/cli/index.ts config trace
```

| Setting | Env | Default | |
|---|---|---|---|
| `trace.enabled` | `D365FO_TRACE_ENABLED` | `false` | Publishes the tool. Off, it costs nothing. |
| `trace.outputDir` | `D365FO_TRACE_DIR` | — | Folder for captures. |
| `trace.maxSeconds` | `D365FO_TRACE_MAX_SECONDS` | `120` | Longest capture (10–900). |
| `trace.maxSizeMB` | `D365FO_TRACE_MAX_SIZE_MB` | `4096` | Largest file (100–20000); `logman` stops by itself there. |

Restart MCP after saving.

**Folder.** Without `trace.outputDir`, captures go to `%TEMP%\d365fo-mcp-trace`. When that drive
(or the configured one) lacks space for the capture asked, `start` does not start: it answers
`TRACE_LOCATION_NEEDED` with every drive and its free space, the agent asks you which folder to
use, and the folder you choose is remembered in `trace-settings.json` beside the index database
for the next captures (a configured `trace.outputDir` always wins).

## Two ways to capture

- **`mode: "auto"`** — the agent reproduces the scenario itself right after `start`: through a
  browser extension it controls (Claude in Chrome, Codex's browser), or by running the job. Then
  `stop` and `analyze`, in one go.
- **`mode: "manual"`** — `start`, then the agent tells you what to do in the D365FO client and
  waits; you do it, say you are done, and the agent calls `stop`. Use it when the scenario needs a
  person, data the agent should not touch, or a client the agent cannot drive.

Either way the capture ends by itself at the time limit or the size limit, even if nobody calls
`stop` (the deadline is also checked on every call, so a restart of the server does not leave a
session running). Only one capture runs at a time.

Good practice: run the scenario once untraced first (the first run pays for caches), keep
captures short, and for a job that runs for hours capture a representative minute in the middle.

## What `analyze` returns

`analyze` reads the capture in its own process (about 15,000 events/s — a 60-second capture of a
busy batch can take minutes) and answers within `waitSeconds` with the result, or with the
progress so far; asking again with the same arguments returns the result when it is ready. Results
are kept beside the capture (`<file>.analysis.<hash>.json`) and reused.

- `focus` — method-name substrings that pick the threads to analyse (e.g. the batch task class),
  so background activity on other threads does not dilute the result. `pid` restricts to one
  process. `scope: "subtree"` counts only time below the focus method.
- `topExclusive` / `topInclusive` / `topCalls` — X++ methods by own time, by time including
  callees, by call count; each with the SQL time issued directly and beneath it.
- `topSqlByTime` / `topSqlByCount` — statements (normalised, truncated) with executions, total,
  preparation, max and their top callers. `repeatedSql` — one caller running the same statement
  at least 50 times: the per-record query in a loop that set-based code or a cache would remove.
- `topRowFetch`, `totals` (SQL share of the selected threads' busy time), `threads`, `openAtEnd`,
  `pairing` and `caveats`.

## Accuracy

The analysis pairs each method's enter and exit per thread on a stack, so recursion and nesting
are counted once; exclusive time is inclusive time minus direct callees. SQL latency events come
after the statement ran and are charged to the X++ method on top of the stack, and rolled up to
its callers. What it cannot know is stated, not guessed:

- **ETW overhead.** Every method event costs time, which inflates small, frequently called
  methods. Rankings and ratios are reliable; absolute seconds are not the untraced run's.
- Exits whose enter came before the capture are counted and ignored; frames still open at the end
  are listed in `openAtEnd` with their time so far (a lower bound); a frame closed by an outer
  method's exit (an exception unwinding, or a lost event) is counted and its time is an upper
  bound.
- The share of SQL is computed over `busySeconds`: the time the selected threads spent inside X++
  frames, plus SQL issued outside any frame. Not the wall-clock span, and not the threads' spans,
  which an idle pool thread would dilute. In a capture taken mid-run, time in the outer method's own
  code before its first traced callee is not seen, so busy time is a lower bound.

## Customer data

A capture contains SQL parameter values, user ids and machine names. The tool never returns
parameter values (bind events are only counted). Keep captures on the VM, do not copy them
elsewhere, and delete them when the analysis is done: `trace_d365fo(action: "delete", file)`
removes a capture and its analyses (only inside the trace folder).
