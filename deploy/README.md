# Deploying Acentric

Ways to run the server, each tested in CI as it is here:

| Recipe                    | For                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| [compose](compose/)       | One machine with Docker, behind Caddy, which gets its HTTPS certificate. The quickest.   |
| [kubernetes](kubernetes/) | A Kubernetes cluster: one server on a volume of its own, behind a Gateway or an Ingress. |
| [systemd](systemd/)       | A machine whose services systemd runs: the image by Docker, or by Podman as a Quadlet.   |

[sandbox](sandbox/) is not a way to run the server: it is what sandboxes at Docker and Boat are made from.

## What every one of them is careful of

- **One server, one disk.** The server keeps everything in `/data`: a SQLite database, and
  conversations' images and files beside it. Run one server, never two on the same data, on a
  disk of the machine it runs on or a block volume. Not on a network file system (NFS, EFS,
  Azure Files): SQLite is not safe on one.
- **HTTPS in front.** The server speaks HTTP. What is in front ends HTTPS, and
  `ACENTRIC_PUBLIC_URL` is its HTTPS address: the links the server makes, and the scripts that
  install the command and the machine program, start with it.
- **Connections that stay open.** Machines' daemons keep a WebSocket to the server, and actors'
  events are a stream. What is in front passes WebSockets, sends the stream as it comes rather
  than in pieces, and does not close either after a minute of quiet. A deployment's code is up
  to 40 MB, so it takes a request that size.
- **The secrets key.** `ACENTRIC_SECRET_KEY` seals agents' secrets and the keys of model
  accounts. Make it once, and keep a copy somewhere other than the server: without it, what it
  sealed cannot be opened again.
- **Stopping.** The server is given a minute to stop, so that a turn that is going on is
  written down.
- **Upgrading.** An exact version, changed on purpose, with `/data` backed up first: see
  [VERSIONS.md](../VERSIONS.md).
