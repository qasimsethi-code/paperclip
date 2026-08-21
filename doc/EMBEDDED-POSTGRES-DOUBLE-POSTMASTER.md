# Embedded Postgres: second postmaster start orphans the listening socket

Field report from reproducing `pnpm dev` startup hangs on Windows while
`pr/embedded-postgres-startup` was in flight. Kept because the detection technique is
reusable even after the underlying bug is closed.

**Environment:** Windows 11, Node v26.4.0, pnpm 9.15.4,
`@embedded-postgres/windows-x64@18.1.0-beta.16`, instance on a non-default port
(server 3101, postgres 54330).

**Symptom:** `pnpm dev` hangs indefinitely. The postgres port reads as LISTEN, the server
never binds its HTTP port, and the instance `logs/` directory stays empty.

## Mechanism

Captured live on `0cb6e2b4f`:

```
00:56:31  postmaster PID 44636 starts, binds 54330, forks io_worker PID 1084
00:56:53  [34352] FATAL:  pre-existing shared memory block is still in use
          [34352] HINT:   Check if there are any old server processes still running,
                          and terminate them.
          [34352] LOG:    database system is shut down
```

A **second postmaster (34352) is started over the same data directory** ~22s after the
first. PostgreSQL correctly refuses it. But postmaster A (44636) also goes away, while its
`io_worker` child survives holding the inherited listening socket:

```
socket owner PID 44636 exists: False
live postgres procs: 1 -> PID 1084 role=io_worker parent=44636 (ORPHAN)
```

Port 54330 then stays in LISTEN state with **no live process behind it**. Clients connect
and block forever (`write CONNECT_TIMEOUT` from a direct postgres.js probe).
`migration-status.ts` blocks on that connection and the dev server never binds its port.

## Why it presents as a hang rather than an error

- CPU across the node tree stays at 0.2-1.7s over many minutes: blocked, not spinning.
- Startup never reaches logging, so the instance `logs/` directory is empty and the only
  postgres output is the buffer the app captures and prints on failure.
- `Get-NetTCPConnection -State Listen` reports the port as listening, so naive port checks
  report postgres as healthy.

**A held socket is indistinguishable from a live server unless you resolve the owning PID
and confirm the process still exists:**

```powershell
$c = Get-NetTCPConnection -LocalPort 54330 -State Listen | Select-Object -First 1
if (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)") { 'ALIVE' } else { 'DEAD-ORPHAN' }
```

Sampling that every 45s turns a silent multi-minute stall into a named failure at ~45s.

## Scope / ruled out

- **Not stale `postmaster.pid`.** Reproduced with the pid file left untouched; PostgreSQL
  arbitrated it correctly and the run still ended in this state.
- **Not external force-kills alone.** The orphan regenerates *within a single clean run*
  starting from a fully released socket.
- **Not commit-specific.** Same signature on `9e2b6aec2`, `d7d55592b`, `394c9a921`,
  `e822ac7ad`, `3632a0633`, `07bd1fc5c`, `0cb6e2b4f`.
- **Clean-socket starts succeed** in ~27-33s, so the data directory and instance config
  are not implicated.

## Status

Not reproduced on `34470cb38` ("probe before starting when no lock file records an
owner"): started healthy in 27s, and again in 27s on a repeat, with no `DEAD-ORPHAN`
observed. Both runs began from a released socket, which has always succeeded, so neither
is conclusive on its own.

### Still reproducing on `34470cb38`

A later run on the same commit, from a clean socket, reproduced the full mechanism:

```
54330 owner PID 27928 alive=False

PID 10472  io_worker  parent 9080   PARENT DEAD -> ORPHAN   started 01:17:06
PID 9568   io_worker  parent 27928  PARENT DEAD -> ORPHAN   started 01:17:37

01:18:00  [43812] FATAL:  pre-existing shared memory block is still in use
          Failed to start embedded PostgreSQL on port 54331
            at formatEmbeddedPostgresError (packages/db/src/embedded-postgres-error.ts:88)
            at startServer (server/src/index.ts:552)
```

**Two** postmasters (9080, then 27928) started 31s apart, both died, each leaving an
`io_worker` orphan. A third attempt (43812) hit the shared-memory FATAL and fell back to
port 54331. Same mechanism as the original capture.

**The failure is intermittent.** Observed runs on `34470cb38`, all from a verified-clean
socket state (no postgres processes, 3101/54330/54331 released), same instance, same
config:

| # | Result | Time | Socket owner during startup |
|---|--------|------|-----------------------------|
| 1 | healthy | 27s | live postmaster |
| 2 | healthy | 27s | live postmaster |
| 3 | **hang** | never bound | `DEAD-ORPHAN` at t=45s |
| 4 | healthy | 33s | live postmaster (`pg=ALIVE`, 21 procs) |

Three healthy to one hang on identical inputs. The discriminator in every case is whether
54330 ends up owned by a live process or by an orphaned `io_worker` — not which commit is
checked out. Treat any single run as weak evidence in either direction.

### Scripted sampling on `54f2d398d`

Five consecutive runs, each preceded by a full kill of all `node` dev processes and **all**
`postgres.exe`, with the baseline asserted clean (0 postgres, 0 dev procs, no listeners on
3101/54330/54331) before starting. A run is only scored if the baseline is clean.

```
run 1: PASS    122s
run 2: ORPHAN   29s
run 3: PASS     98s
run 4: ORPHAN   21s
run 5: ABORT  - baseline DIRTY pg=10 node=0 listeners=0

SUMMARY: pass=2 orphan=2 other=1 of 5
```

**~50% failure rate under back-to-back restarts.**

Run 5 aborted with `pg=10 node=0`: ten `postgres.exe` alive with no node process owning
them. Those turned out to be **unrelated** — a temp cluster under `%TEMP%` from the repo's
own test harness (`test-embedded-postgres.ts`), not dev instance leftovers. See the
scoping note below.

### Scripted sampling on `6efc5531c`

Same harness, cleanup now scoped to the `dev` instance only:

```
run 1: ORPHAN 45s
run 2: PASS   40s
run 3: ORPHAN 14s
run 4: PASS   43s
run 5: ORPHAN 42s

SUMMARY: pass=2 orphan=3 other=0 of 5
```

All five baselines were clean this time (no aborts), so every run is a valid sample.

### Second batch on `6efc5531c` (HEAD unchanged across the loop)

```
run 1: ORPHAN 70s
run 2: PASS   61s
run 3: PASS   60s
run 4: PASS   57s
run 5: PASS   55s

SUMMARY: pass=4 orphan=1 other=0 of 5
```

### Third batch on `1c3fd3d36` (docs-only commit atop `6efc5531c`, so same code)

```
run 1: PASS   65s
run 2: PASS   75s
run 3: ORPHAN 54s
run 4: ORPHAN 20s
run 5: PASS   53s

SUMMARY: pass=3 orphan=2 other=0 of 5
```

### Aggregate

| Commit | Runs | Pass | Orphan |
|--------|------|------|--------|
| `54f2d398d` | 4 scored (+1 abort) | 2 | 2 |
| `6efc5531c` batch 1 | 5 | 2 | 3 |
| `6efc5531c` batch 2 | 5 | 4 | 1 |
| `1c3fd3d36` (same code) | 5 | 3 | 2 |
| **total** | **19** | **11** | **8** |

**Pooled over the current code (`6efc5531c` / `1c3fd3d36`), n=15: 9 pass / 6 orphan —
40% failure.**

Per-batch pass rates were 40%, 80%, 60% on identical code. That spread at n=5 is the
clearest argument against judging this from a single batch; pooled across 15 runs the
estimate settles near 60% pass / 40% fail.

**Batch-to-batch variance is large.** The same commit produced 2/5 and then 4/5. A single
5-run batch cannot distinguish a 40% failure rate from 60%, so do not compare commits on
one batch each — an earlier revision of this document did exactly that and wrongly implied
`6efc5531c` was worse than its predecessor.

**Absolute timings are not comparable between batches** (27-33s manual, 40-43s, 55-70s,
98-122s — all on passing runs). They track machine load, not code. Only pass/fail is
stable enough to compare.

### Correction: startup slowness was not caused by restart cadence

An earlier revision attributed the 98-122s passes on `54f2d398d` to tight restart cycles.
On `6efc5531c` the passes were 40s and 43s using the identical harness and cadence, which
does not support that explanation. The slow runs coincided with the test harness's temp
postgres clusters running concurrently, so **machine contention from other postgres work
is the likelier cause**. Startup time is sensitive to load; a fixed timeout tuned against
an idle machine will misfire when tests are running alongside.

### Scoping warning for anyone reproducing this

Do **not** clean up by killing every `postgres.exe`. The test harness creates temp
clusters under `%TEMP%`, and the `default` instance may be running via the MCP server;
a blanket kill destroys in-flight test databases and other people's work. Match dev
postmasters by data directory (`instances\dev\db`) and children by parent PID or by
ownership of the dev postgres port, and leave everything else alone.

Sampling harness (kept in case it is useful): a `devctl.ps1` exposing `cleanup` /
`baseline` / `pgowner`, driven by a bash loop. Two traps worth avoiding if reproducing
this: PowerShell embedded in nested bash quoting silently matches nothing (an early
version killed postgres but not the node tree, so the health probe hit the *previous*
server and scored `PASS 1s`), and any `PASS` faster than ~8s should be rejected outright
as a stale-server artifact.

### Withdrawn claim

An earlier revision of this document asserted that orphan creation "appears fixed" on
`34470cb38`, based on manually killing a live postmaster twice and observing its children
reap cleanly. **That inference was wrong and is withdrawn.** A manual `Stop-Process` on the
postmaster is not the same event as whatever terminates it during startup, so clean
teardown under that synthetic condition said nothing about the real failure path.

### Suggested test

Because the live path is timing-dependent, prefer a unit-level test over live runs:
fabricate a lock/port state where the recorded owner PID does not exist, and assert the
probe adopts or refuses rather than blocking.

## Cleanup note

Killing a runner tree kills the postmaster but leaves `io_worker` children holding the
socket, reproducing the same end state. Cleanup must terminate **all** `postgres.exe`, not
only the process with `-D` in its command line — children carry no `-D` and are missed by
the obvious filter.
