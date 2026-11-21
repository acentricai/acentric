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
| `pnpm build`      | Builds every package, each once, in the order they depend.     |
| `pnpm test`       | Builds, then runs every test.                                  |
| `pnpm lint`       | Lints with oxlint. A warning fails it.                         |
| `pnpm format`     | Formats with Prettier. `pnpm format:check` only checks.        |
| `pnpm boundaries` | Checks which package depends on which (see below).             |
| `pnpm check`      | All of the above but `format`: what CI runs for TypeScript.    |
| `pnpm check:rust` | `cargo fmt`, `clippy` and `test`: what CI runs for the daemon. |
| `pnpm clean`      | Removes what `build` made.                                     |

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
