# Contributing to Acentric

Thanks for your interest in Acentric. Bug reports, documentation fixes,
runners, and features are all welcome.

## Before you start

- **Bugs:** open an [issue](https://github.com/acentricai/acentric/issues/new/choose)
  with what you did, what you expected and what happened. A failing test or a
  small agent that shows the problem helps most.
- **Features and larger changes:** open an issue to discuss the design before
  writing the code. The framework's contract is shared by every runner, so
  changes to it are made carefully.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

You need [Node.js](https://nodejs.org) 22.13 or later and
[pnpm](https://pnpm.io) (the version in `packageManager` in `package.json`;
`corepack enable` sets it up).

```bash
git clone https://github.com/acentricai/acentric.git
cd acentric
pnpm install
pnpm build
pnpm test
```

## The repository

| Folder                                                   | Holds                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| [`packages/`](packages)                                  | the published packages: types, testing, CLI, client, llm, ... |
| [`runners/`](runners)                                    | the memory and local runners                                  |
| [`packages/conformance/scenarios`](packages/conformance) | the scenarios every runner must pass                          |
| [`templates/`](templates)                                | templates for agents, not yet published                       |
| [`docs/`](docs/README.md)                                | the documentation, in Markdown                                |
| [`scripts/`](scripts)                                    | repository tooling, such as the docs check                    |

Packages build with TypeScript project references (`tsc --build`) and are
tested with [Vitest](https://vitest.dev). Linting is
[oxlint](https://oxc.rs) and formatting is [Prettier](https://prettier.io).

## Checks

| Command                | Does                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `pnpm build`           | builds every package                                                    |
| `pnpm test`            | runs the tests                                                          |
| `pnpm lint`            | lints with type information                                             |
| `pnpm typecheck:tests` | type-checks the tests and templates                                     |
| `pnpm format`          | formats everything; `pnpm format:check` only checks                     |
| `pnpm docs:check`      | checks every Markdown link, and type-checks and runs the docs' examples |
| `pnpm check`           | all of the above, as CI runs it                                         |

Run `pnpm check` before opening a pull request.

## Making a change

- **Keep `step` pure.** An agent's pure half does no I/O. Anything new that
  touches the world belongs in handlers or runners.
- **Runners follow the specification.** A change to what runners do starts in
  [the runner specification](docs/reference/runner-spec.md), comes with
  [conformance scenarios](packages/conformance) that check it, and lands in
  both runners together.
- **Test what you change.** Pure code is tested with `simulate` from
  `@acentric/testing`; runners with the conformance scenarios and their own
  tests.
- **Update the docs.** If a change alters behaviour described in `docs/` or a
  package README, update it in the same pull request. TypeScript examples in
  `docs/` are type-checked, and the ones whose fence says `run` are run; mark
  an example `nocheck` only if it cannot be made to compile.
- **Add a changelog entry** under "Unreleased" in [CHANGELOG.md](CHANGELOG.md)
  for anything a user of the packages would notice.

Commit messages describe what the change does, in the imperative, such as
"Reject a secret that is not set with SecretNotSet on every runner", with a
body explaining why when it is not obvious.

## Writing documentation

Docs are plain Markdown and read on GitHub. Link between pages with relative
paths (`../concepts/state.md#the-window`); `pnpm docs:check` fails on a link to
a file or heading that does not exist. A code block's `title="src/agent.ts"`
names its file, so the examples on a page can import each other.

## Releasing

Maintainers release every published package together, at the same version:

1. Move the "Unreleased" entries in [CHANGELOG.md](CHANGELOG.md) under the
   new version.
2. Set that version in each published package's `package.json`
   (`pnpm -r exec npm version <version> --no-git-tag-version`), and in
   `LLM_VERSION` in `packages/llm/src/version.ts`; a test keeps them equal.
3. Commit, then tag the commit `v<version>` and push the tag.

The [release workflow](.github/workflows/release.yml) runs `pnpm check` and
publishes every package to npm with provenance.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the project's license.
