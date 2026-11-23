# What the server keeps, and for how long

Everything is in its folder of data (`/data` in the image): a SQLite database, and the images
and files of conversations as files beside it ([BACKUPS.md](BACKUPS.md)).

| What                                                                                                                            | Kept                        | Removed                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents, their deployments and secrets                                                                                           | For as long as the agent is | With the agent (the dashboard, or `DELETE /v1/agents/{agent}`)                                                                                                                                                        |
| Actors: their conversations, mailboxes, compactions, tasks, scripts, machines' commands, and the images and files only they had | For as long as the actor is | With the actor, once it is archived (`acentric actors delete <actor> --yes`, the dashboard, `DELETE /v1/actors/{actor}`), its subagents with it; or, with `ACENTRIC_RETAIN_ARCHIVED`, that long after it was archived |
| Usage: what each call of a model used and cost                                                                                  | For ever                    | With `ACENTRIC_RETAIN_USAGE`, that long after the call: the Usage page has nothing from before                                                                                                                        |
| The audit log                                                                                                                   | For ever                    | With `ACENTRIC_RETAIN_AUDIT`, that long after it was written                                                                                                                                                          |
| Sessions, and invite, setup and reset links                                                                                     | Until they expire           | When they expire                                                                                                                                                                                                      |

The settings take a time such as `90d` or `12h`. Without them, nothing is removed for its age.
Deleting an actor is not undone; what it cost stays in the usage, and its deletion is in the
audit log.

## How it is removed

Every hour, a minute after it starts, the server removes what has had its day, a few hundred
at a time, so that it never holds the database for long. What a setting removed is in the
audit log, as `retention.removed` with how many of each; the metrics count it too
(`acentric_retention_removed_total`).

**What is removed is in the backups taken before**, until those go as well: how long you keep
backups, and copies of them, is how long what was removed is kept.

## The disk

A database made by this version gives back to the disk what is removed from it, as it goes. One
made before keeps that room for what comes next, and does not shrink: the server says, as it
starts, when a good part of it is unused. To give it back, with the server stopped:

```sh
acentric-server compact
```

It writes a copy of the database as it goes, so it needs as much room free again, and from
then on the database gives back what is removed. How it is run in each recipe is as for
`acentric-server restore` in its README.
