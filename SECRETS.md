# Secrets

What a server is given that no one else may have, where each is, and how the key secrets are
sealed with is changed.

## The keys a server is given

- **`ACENTRIC_SECRET_KEY`**, 32 bytes as 64 hex characters (`openssl rand -hex 32`), seals
  what the server keeps that is secret: agents' secrets, the keys of model accounts and sandbox
  providers, and actors' variables. The database only has them sealed, and a backup never has
  the key. Without it the server keeps none of them. **Keep a copy somewhere other than the
  server and its backups**: without it, what it sealed does not open again.
- **`ACENTRIC_ADMIN_KEY`**, of 24 characters or more, is an API key that may do everything,
  which other keys are made with. It is not kept in the database: it works while the server is
  given it.
- **`ACENTRIC_SECRET_KEYS_OLD`**, keys secrets were sealed with before, separated by commas, so
  that what they sealed still opens after the key was changed.

Each is given in a file in place of the environment, by its path in `<name>_FILE`
(`ACENTRIC_SECRET_KEY_FILE` and the like), as Docker's and Kubernetes' secrets are: what is in
the file is the value. Not both. A file is better: a process's environment is seen by more
than its files are (`docker inspect`, `kubectl describe` where it is written in the pod,
`/proc/<pid>/environ`). Every recipe in [deploy/](deploy/) gives them as files. The processes
agents' code runs in are given no environment of the server's at all.

## With no admin key

A server that has no `ACENTRIC_ADMIN_KEY` and no key yet makes one when it first starts, and
writes it to `<ACENTRIC_DATA>/first-admin-key` (`/data/first-admin-key` in the image), for the
server's user alone: never to its log, which more people keep and read than the server's
data. Copy it somewhere safe and remove the file. It is not written again.

The setup link, which makes the first person the owner, is in the log: it works once, a new
one is made each time a server with no person starts, and it is nothing once used.

## Changing the secrets key

1. Make a new key, and give it as `ACENTRIC_SECRET_KEY`, with the old one in
   `ACENTRIC_SECRET_KEYS_OLD`. Start the server: everything opens, and what is sealed from now
   on is sealed with the new key. The server says, as it starts, how many values are sealed
   with the old one.
2. With the server stopped, seal them all again with the new key:

   ```sh
   acentric-server reseal
   ```

   It seals everything in one go, or nothing, and says how many it sealed. It is refused while
   a server runs on the data.

3. Take the old key out of `ACENTRIC_SECRET_KEYS_OLD`. The server says, as it starts, when an
   old key it is given seals nothing, and when something is sealed with a key it was not
   given.

A backup says which keys sealed what is in it, so a backup from before the change needs the
old key to be put back ([BACKUPS.md](BACKUPS.md)). Keep the old key as long as you keep such
backups.

## Changing the admin key

Give the server another `ACENTRIC_ADMIN_KEY`, and start it again: the old one works no more.
A key made with the API, the first key among them, is revoked on the dashboard's API keys
page, or by `DELETE /v1/keys/{key}`.
