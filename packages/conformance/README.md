# @acentric/conformance

The scenarios every runner must pass to conform to [RUNNERS.md](../../RUNNERS.md),
the probe agent they drive, and a player for runners written in TypeScript.

## Scenarios

[scenarios](scenarios) holds one JSON file per scenario, named by the section
of RUNNERS.md it checks. A scenario is a list of steps: actions, after each of
which the runner settles, and expectations about what must then be true.

| Action      | Does                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| `create`    | creates the session from a probe bundle with a config                    |
| `input`     | sends an input                                                           |
| `configure` | sends a config change                                                    |
| `release`   | finishes a gate, returning a value or throwing                           |
| `wait`      | lets a few milliseconds of real time pass                                |
| `crash`     | stops the runner abruptly and starts it again (needs `durable`)          |
| `upgrade`   | upgrades the session to version 2 of the probe (needs `upgrade`)         |
| `fork`      | forks the session at a journal entry and acts on the fork (needs `fork`) |

| Expectation                      | Checks                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| `accepted`, `rejected`, `failed` | the answer to the last create, input, config change or upgrade              |
| `running`                        | the running effects, exactly, with their kind, args, attempt and abort flag |
| `signalled`                      | gates whose signal fired                                                    |
| `log`, `logKinds`                | the newest log entries, partly; the kinds of the whole log                  |
| `snapshot`                       | the snapshot, partly                                                        |
| `journal`                        | the newest journal entries, partly (needs `journal`)                        |

After every action the log must also be numbered 1, 2, 3 with no gaps, with
times that never go backwards. For a runner that offers `journal`, the
player also replays the session's journal with the probe's code after every
action: each entry must give the answer and digest it recorded, and the
replay must end with the runner's log and snapshot. A scenario that needs a feature the runner does
not offer is skipped and reported, never passed.

## The probe

The probe is a test agent with no behaviour of its own: each input says what
its step does (declare, drop or abort effects, append, reject, throw, return
something that is not JSON, move its window, report what it saw). It ships as
the two-module bundle RUNNERS.md describes, in [src/probe](src/probe), with a
version 2 for upgrades and a handlers module a runner must refuse.

Its `gate` handler waits until the scenario releases it, through a hook the
runner's adapter installs as `globalThis.conformance` wherever handlers run.
Runners in TypeScript can use `createGateHook`.

## Playing scenarios

A runner provides an `Adapter`: create, input, configure, release, settle,
and ways to read what is running, the log and the snapshot.
`play(scenario, open)` plays one scenario through it. Runners in other
languages implement the same small format themselves.

The tests here play every scenario against a reference adapter built from the
simulator, which checks the scenarios themselves before a real runner exists.
