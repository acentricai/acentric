# Contributing

## Setting up

You need Node 24 or newer and pnpm. The pnpm version is the `packageManager` of the root
`package.json`. The daemon needs Rust: `rustup` installs the version `rust-toolchain.toml`
names the first time `cargo` runs here. If you are not touching the daemon, you do not need Rust.

```sh
pnpm install
```

## The commands

| Command           | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `pnpm build`      | Builds every package, and the command as one file.             |
| `pnpm test`       | Builds, then runs every test.                                  |
| `pnpm lint`       | Lints with oxlint. A warning fails it.                         |
| `pnpm format`     | Formats with Prettier. `pnpm format:check` only checks.        |
| `pnpm boundaries` | Checks which package depends on which (see below).             |
| `pnpm check`      | All of the above but `format`: what CI runs for TypeScript.    |
| `pnpm check:rust` | `cargo fmt`, `clippy` and `test`: what CI runs for the daemon. |
| `pnpm clean`      | Removes what `build` made.                                     |
| `pnpm bench`      | Measures how fast the engine turns, on a database on disk.     |

Run `pnpm check`, and `pnpm check:rust` if you changed the daemon, before you open a pull request.

## How the repository is laid out

- `packages/` has the libraries, and `apps/` what runs: the server, the command and the daemon.
- A package's code is in `src`, its tests in `test`, and what it builds in `dist`.
- TypeScript is one pnpm workspace (`pnpm-workspace.yaml`), built with project references
  (`tsconfig.json`). Rust is one Cargo workspace (`Cargo.toml`).

## Boundaries

`boundaries.json` says, for every package, the packages of this repository it may depend on.
`pnpm boundaries` fails when a package depends on another it may not.

To use one package from another:

1. Add it to the package's `dependencies` as `"workspace:*"`, and run `pnpm install`.
2. Add its folder to the `references` of the package's `tsconfig.json`.
3. If `boundaries.json` does not allow it yet, say why it should in your pull request, and add it there.

A new package also goes in the root `tsconfig.json` and in `boundaries.json`. `pnpm boundaries`
says which of these is missing.

## Tests

Tests run with vitest, from the root. A test file is `test/<name>.test.ts` in its package.
`pnpm test` builds first.

Two sets of tests are written against an interface, and run on everything that implements it:
`packages/core/test/store-suite.ts` is what any store must do, and
`packages/core/test/engine-suite.ts` what the engine does on any store. A new store runs both.

`packages/store/test/crash.test.ts` runs the engine as a process of its own and kills it at
every point where an actor's state changes. A change to how a turn is stored is not done until
it passes.

## Model providers

A provider is one file in `packages/ai/src/providers`, which writes its own request and reads
its own answer. Nothing in the engine names a provider.

The tests do not call a provider. They replay what was recorded of the real one, in
`packages/ai/test/fixtures`. To add a provider, or to change what one sends:

1. Add it to the list in `packages/ai/test/record.ts`.
2. Run that script with the provider's key in the environment. It makes a few real calls and
   writes what was sent and answered, with no key in it.
3. Read what it wrote before you commit it.

Two more scripts make real calls and are run by hand: `packages/ai/test/cache-check.ts` says
whether a provider keeps what it has read, and `packages/core/test/live.ts` runs one turn
through the whole engine for each provider.

## Changesets

A pull request that changes what a published package does needs a changeset: a short file that
says which packages changed and how, in words for the people who use them.

```sh
pnpm changeset
```

Every published package has the same version, and they are released together. While
`.changeset/pre.json` is there, releases are alpha versions.

## Style

- TypeScript is strict, and only syntax that can be erased: no enums, no parameter properties.
- A comment says why the code is as it is, or what a reader could not tell from it.
- Prettier decides the formatting.

## Licence

What you contribute is under the [Apache-2.0 licence](LICENSE), as the rest is.
