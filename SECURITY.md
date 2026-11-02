# Security policy

## Supported versions

Acentric is at 0.x. Security fixes are made in the latest released version
only.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues, discussions
or pull requests.

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/acentricai/acentric/security/advisories/new).
Include what is affected, how to reproduce it, and the impact you expect.

We will acknowledge the report within a few working days, keep you updated
while we work on a fix, and credit you in the advisory unless you prefer
otherwise.

## Scope

Handlers run with the permissions of the runner that hosts them: the local
runner runs them as child processes with access to the machine, and gives
them the secrets named in a project's config. Running an agent bundle you do
not trust is like running any other code you do not trust. Reports about how
runners isolate sessions, handle secrets, or expose their protocol
(WebSocket and stdio) are especially welcome.
