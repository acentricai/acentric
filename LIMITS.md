# Limits, and how large a server to run

What one server handles, as measured, what holds it back first, and what to give it. One
server is the whole of it: it keeps everything in one SQLite database on one disk, and two
servers never share one ([deploy/README.md](deploy/README.md)). A server that has outgrown its
machine is given a larger one.

## What holds a server back, in order

1. **`ACENTRIC_MAX_TURNS`, 1,000 without it.** It is how many actors are in a turn at once; the
   rest wait their turn, in order. A turn mostly waits for its model, so this, not the machine,
   is what holds a server back first when it is too low: at 100, as it was before, a server
   did about 1,000 turns a minute with the machine nearly idle (at 200 actors waiting, a
   4-vCPU server was at 14% of its CPU). Every machine measured here took 1,000 at once with
   room to spare, so that is what it is without the setting. Lower it for a smaller machine,
   or raise it on a faster disk (below).
2. **The disk.** Each turn is about four commits to the database, and each commit waits for the
   disk to say it is written. On an EBS gp3 volume that is about 2 ms, some 500 a second, and
   a server does about **12,000 to 14,000 turns a minute**, whatever its CPU: on a 4-vCPU machine
   at 32% of its CPU, as on a 2-vCPU one at 60%. A faster disk lifts it: with its data on a disk
   that waits for nothing (memory), the same 2-vCPU machine did 19,700 a minute, at all of its
   CPU. Local NVMe (an instance's own disk) or io2 is the way past it.
3. **CPU,** after that.

Memory is not what runs out first: see what it takes, below.

## Measured

On AWS, in ap-southeast-2, with Amazon Linux 2023 and the server of 0.15.0 and what came
after it (`main`, November 2026), its data on a 30 GB gp3 volume, two processes for agents'
code (`ACENTRIC_CODE_PROCESSES=2`, as without it), `ACENTRIC_MAX_TURNS=2000`, and the load
sent from another machine in the same network.

Each actor was sent a message, its turn followed on its event stream to its end, then it paused
1 to 3 seconds, and again. A turn was two calls of the model and one of the agent's tool (the
tests' orders agent, 766 KB of code), and an answer of about 300 tokens. The model was a
stand-in that answers as models do: seven calls in ten in under 2 seconds, the rest in 2 to 10
(2.5 seconds on the average, so a turn took about 3.3 seconds, and 11 at the 95th percentile).
Every turn of every run ended well.

| Actors |                                 | t4g.medium (2 vCPU, 4 GB) | t4g.large (2 vCPU, 8 GB) | c7g.xlarge (4 vCPU, 8 GB) |
| -----: | ------------------------------- | ------------------------: | -----------------------: | ------------------------: |
|    100 | turns a minute                  |                       788 |                      740 |                       781 |
|        | CPU, memory                     |               11%, 215 MB |              11%, 220 MB |                6%, 218 MB |
|    300 | turns a minute                  |                     2,227 |                    2,246 |                     2,320 |
|        | CPU, memory                     |               23%, 254 MB |              24%, 259 MB |               13%, 230 MB |
|    600 | turns a minute                  |                     4,504 |                    4,528 |                     4,506 |
|        | CPU, memory                     |               39%, 299 MB |              40%, 298 MB |               21%, 316 MB |
|  1,000 | turns a minute                  |                     7,418 |                    7,418 |                     7,540 |
|        | CPU, memory                     |               54%, 336 MB |              55%, 424 MB |               32%, 446 MB |
|        | the server's own time in a turn |                     52 ms |                    42 ms |                     28 ms |
|  2,000 | turns a minute                  |                    10,533 |                   10,582 |                    10,748 |
|        | CPU, memory                     |               70%, 574 MB |              68%, 753 MB |               40%, 812 MB |
|        | the server's own time in a turn |                  1,611 ms |                 1,687 ms |                  1,583 ms |

To 1,000 actors, each machine did as much as its actors asked, and added tens of milliseconds
to a turn of seconds. At 2,000 each reached the disk's ceiling, and turns took twice as long,
waiting for the database. CPU is the server's own process; the processes of agents' code are
apart.

With a model that answers at once, which only the server's own ceiling holds back:

| Actors | t4g.medium | t4g.large | c7g.xlarge |
| -----: | ---------: | --------: | ---------: |
|     50 |     11,103 |    10,408 |     13,942 |
|    150 |     13,138 |    12,914 |     14,128 |
|    300 |     12,338 |    12,221 |     12,143 |
|    600 |     12,783 |    12,597 |     12,717 |

Turns a minute: the same on each, at 59% to 67% of the CPU of the 2-vCPU machines and 32% of
the 4-vCPU one. The disk, again.

## What it takes

- **Memory:** about 200 MB for the server, and about 0.3 MB for each actor in memory: in a
  turn, or among the 1,000 last used (more are read from the database again when they are
  sent something). Each process of agents' code is about 50 MB, and each deployment it holds
  about 8 MB more (measured with the 766 KB agent: one with more code takes more). A process
  over 1 GB is replaced, when it has no call in it.
- **Claude** (`ACENTRIC_CLAUDE=on`): each conversation on a Claude plan that is in a turn, or
  was in the last `ACENTRIC_CLAUDE_IDLE`, has a process of Claude Code's of its own: about
  250 MB, seen with a conversation of 40,000 tokens. The server keeps one for each 600 MB of its
  memory, or `ACENTRIC_CLAUDE_SESSIONS`, and stops the one that waited longest to start
  another. The SDK and Claude Code take about 450 MB of disk, in `<ACENTRIC_DATA>/claude`.
- **Disk:** about 7 KB of database for each turn of two calls of a model and a tool, with an
  answer of 300 tokens: some 7 GB for a million such turns, and more for longer conversations,
  and for their images and files. [DATA.md](DATA.md) says how long it is kept, and how it is
  removed.
- **Agents' code:** a call of a deployment that is loaded took under 1 ms; loading one, 40 to
  60 ms. Two processes answered 2,000 to 3,000 calls a second. Under the loads above, nine
  tool calls in ten took under half a second.

## How large, then

|                           | Small                              | Medium                   | Large                                           |
| ------------------------- | ---------------------------------- | ------------------------ | ----------------------------------------------- |
| Machine                   | 2 vCPU, 4 GB (t4g.medium)          | 2 vCPU, 8 GB (t4g.large) | 4 vCPU, 8 GB or more                            |
| Actors in a turn at once  | up to about 1,000                  | up to about 1,000        | up to about 1,000 on gp3; more on a faster disk |
| `ACENTRIC_MAX_TURNS`      | 1000                               | 1000                     | 1000, or 2000 on NVMe                           |
| `ACENTRIC_CODE_PROCESSES` | 2                                  | 2                        | 2; 4 for agents whose code works hard           |
| Deployments held          | about 100                          | about 300                | about 300                                       |
| Disk                      | 20 GB and up, and room for backups |                          | Local NVMe or io2, past 10,000 turns a minute   |

More vCPU does not lift the disk's ceiling: give a larger machine for memory (many deployments,
many actors) or for agents' code that works hard, and a faster disk for more turns.

## When a server is at its limit

Nothing fails: turns wait. The metrics say so ([deploy/README.md](deploy/README.md)):

- `acentric_turns_waiting` above 0 for long: turns wait for one going on to end. Raise
  `ACENTRIC_MAX_TURNS`, if the machine has room.
- `acentric_turn_duration_seconds` growing with no more of `acentric_model_call_duration_seconds`:
  the server's own time in a turn grows, at the disk's or the CPU's ceiling.
- `acentric_event_loop_delay_seconds` past a tenth of a second: the server's CPU.
- `acentric_process_resident_memory_bytes` near the machine's memory.

## Not measured here

Machines' daemons connected by the thousand; sandboxes; conversations long enough to be
compacted on every turn; a server run for days, for what grows slowly; x86 machines; disks
other than gp3, but for memory.

## How it is measured

`apps/server/bench/load-server.ts` starts the server as its program starts it, with a stand-in
model in the process (`LOAD_MODEL_MS=mixed`, or a number of milliseconds), and
`apps/server/bench/load.ts`, from another machine, sends it the load in steps and reads its
metrics: [the files](apps/server/bench/) say how. `pnpm bench:isolates` measures agents' code
alone.

## Every limit there is

|                                       |                                                                      |
| ------------------------------------- | -------------------------------------------------------------------- |
| Actors in a turn at once              | `ACENTRIC_MAX_TURNS`, 1,000 without it                               |
| Actors kept in memory between turns   | 1,000                                                                |
| Deployments' code held, for calls     | 300: past it, the one called longest ago is loaded again when called |
| Emails whose failed sign-ins are kept | 10,000                                                               |
| Processes of agents' code             | `ACENTRIC_CODE_PROCESSES`, 2 without it; each replaced past 1 GB     |
| Processes of Claude Code, with Claude | `ACENTRIC_CLAUDE_SESSIONS`, one for each 600 MB of memory without it |
| An agent's code                       | 10 MB                                                                |
| A request that deploys                | 40 MB; any other, 1 MB                                               |
| An image or file from a machine       | 8 MB                                                                 |
| A secret                              | 64 KB                                                                |
| A picture of a person                 | 2 MiB: a PNG, JPEG or WebP                                           |
| A page of a list                      | 200                                                                  |
| How long a command is waited for      | 300 seconds                                                          |
| How long a sandbox is kept, idle      | 30 days                                                              |
| A template's script                   | 64 KB, run for at most an hour; the last 64 KB of its output is kept |
| Servers on one folder of data         | 1                                                                    |
