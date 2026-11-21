# Walking skeleton

**Throwaway.** This is deleted when the real core is written. Nothing here is a decision, and
nothing outside this folder may depend on it.

It answers one question: do the interfaces the engine's core will be built on fit together? It
runs one turn of one actor from end to end, on fake parts, and then runs it again across a
restart.

| File                | What it is                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `src/interfaces.ts` | A first guess at the store, the model runner, the executor and the event bus.            |
| `src/machine.ts`    | The turn machine: where an actor stands, and something that happened, to what is stored. |
| `src/engine.ts`     | The loop that does what an actor is owed, and feeds what happened to the machine.        |
| `src/fakes.ts`      | A store and a bus in memory, a scripted model, an executor with no isolation.            |

```sh
pnpm vitest run spikes
```

## What it showed

- **The parts fit.** A message goes in, the model is called, its tool runs, and the answer is
  stored, through four interfaces. A second engine on the same store finishes a turn the first
  left half done.
- **The machine needs no list of things to do.** What is owed next is read off the state it
  stored. A restart reads the same state, so recovery is the ordinary loop.
- **A runner reads the tool calls out of its own answer.** The engine cannot: an answer is its
  provider's own output.
- **The mailbox is written apart from the turn.** An input arrives at any moment and names no
  epoch, so the count of waiting inputs is the store's to give, not the machine's to keep.
- **It stores five times** for a turn of two model calls and one tool call: the mail taken, each
  answer, each tool's result, and the return to the model. That last one could ride with the
  last result.
- **Tool results go in one after another,** though the tools run side by side: each store names
  the epoch the one before it left.
- **The epoch shuts out a process that was thought gone.** Its late answer is refused.

## What it leaves open

- **A call that had not begun looks like one that was cut off.** The state says a tool call is
  owed, not whether it was started. So after a restart a call that is not safe to make again is
  answered "may or may not have run" even if it never began. The old harness stored once more
  for each call to tell the two apart.
- **One process still needs to know what it is driving.** That is a map in memory, with a mark
  for an actor woken while it was held. The epoch does not replace it.
- **An agent's input handler runs before the store says the input is a duplicate.**
- **The agent's definition is asked for at every step,** and the whole conversation is read at
  every call of the model.
- **Not tried at all:** retries, compaction, interrupting, archiving, tasks that detach, a real
  database, real isolation, and an actor moving to another deployment.
