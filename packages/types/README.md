# @acentric/types

The types an acentric agent is made of. Types only: nothing here runs.

```ts
import type { Agent, HandlersFor, KindsOf } from '@acentric/types';
```

| Part     | Types                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| Data     | `Json`, `JsonObject`, `JsonArray`: everything an agent keeps and exchanges            |
| State    | `State`, `LogEntry`, `LogWindow`: the snapshot, the log and the config a step sees    |
| Messages | `Message`: an `input`, an `effect` result, a `config` change or `migrated`            |
| Effects  | `EffectRequest`, `Kinds`, `Mode`: the I/O an agent asks for, by kind                  |
| Handlers | `HandlerDef`, `HandlerContext`, `HandlersFor`, `KindsOf`: the code that does that I/O |
| Agent    | `Agent`, with `Init`, `Step`, `Effects`, `View`, `Window` and `Migrate`               |
| Journal  | `JournalEntry`: what a session received, for replaying it                             |

An agent's pure half (`init`, `step`, `effects`, `view`, `window`, `migrate`)
decides; its handlers do the I/O. A runner connects them, following
[RUNNERS.md](../../RUNNERS.md). The docs at
[docs.acentric.dev](https://docs.acentric.dev) explain each part.
