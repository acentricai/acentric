# create-acentric

Creates an acentric agent project.

```bash
npm create acentric@latest my-agent
cd my-agent
npm run dev
```

It asks for a folder and whether to install, unless given them:

| Option            | Means                                                        |
| ----------------- | ------------------------------------------------------------ |
| `[dir]`           | the folder to create; it must not exist, or be empty         |
| `--template NAME` | the template; `minimal` for now                              |
| `--pm NAME`       | npm, pnpm, yarn or bun; defaults to the one that ran it      |
| `--no-install`    | do not install dependencies                                  |
| `--no-git`        | do not run `git init`                                        |
| `-y`, `--yes`     | ask nothing                                                  |
| `--local DIR`     | take the acentric packages from a checkout of the repository |

## The minimal template

A notes agent with reminders, so it runs with no API key. It shows the pure
half (inputs, rejections, the log and the view), an effect (a reminder is
the runner's `@timer`), where handlers go, and tests of the pure half with
the simulator. The project's scripts are `dev`, `build`, `start`, `test` and
`typecheck`.

## Before a release

`--local` packs each acentric package from a checkout into the new
project's `.acentric/packages`, the way publishing packs it, and points the
project's dependencies at those tarballs. A project made that way installs,
tests, builds and runs exactly as one from a published release would.
