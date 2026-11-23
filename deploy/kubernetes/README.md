# Kubernetes

The server as a StatefulSet of one, on a volume of its own, with
[Kustomize](https://kustomize.io), which `kubectl` has.

| Folder    | What                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `base`    | The server alone: its namespace, StatefulSet and Service.                |
| `gateway` | The base, behind a Gateway of the cluster's (Gateway API): an HTTPRoute. |
| `ingress` | The base, behind an Ingress controller's Ingress.                        |

## Why it is as it is

- **One replica, always.** What the server keeps is one SQLite database on one volume. A
  StatefulSet of one stops its pod before it starts the next, so an upgrade never has two
  servers on that volume. Never scale it up, and give it no autoscaler.
- **A block volume.** `ReadWriteOnce`, of the cluster's default storage class, or one you name.
  Not a network file system.
- **No Service variables.** Kubernetes gives a pod a variable for each Service of its
  namespace, and the Service `acentric` would set `ACENTRIC_PORT`, which is the server's own.
  `enableServiceLinks: false` keeps them out.
- **Non-root,** with no privileges and no capabilities.

## Running it

```sh
kubectl create namespace acentric
kubectl -n acentric create secret generic acentric-secrets \
  --from-literal=ACENTRIC_SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=ACENTRIC_ADMIN_KEY="$(openssl rand -hex 24)"
```

Keep a copy of the secrets key somewhere other than the cluster. In a folder of your own, a
`kustomization.yaml` that takes one of these and sets the version and the address:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/acentricai/acentric//deploy/kubernetes/gateway?ref=v0.15.0
images:
  - name: ghcr.io/acentricai/acentric-server
    newTag: 0.15.0
configMapGenerator:
  - name: acentric-settings
    behavior: replace
    literals:
      - ACENTRIC_PUBLIC_URL=https://engine.example.com
```

With the Gateway's name and namespace, and the name people use, set in a patch of the
HTTPRoute (or the Ingress's host, class and certificate): `kubectl apply -k .`. The setup link
is in `kubectl -n acentric logs acentric-0`.

## What is in front

Whatever ends HTTPS must:

- pass WebSockets, for machines' daemons;
- not buffer responses, for actors' event streams;
- leave a connection open with nothing sent for an hour, not a minute;
- take a request of 40 MB, for a deployment's code.

The HTTPRoute sets its timeouts to none. The Ingress has the NGINX controllers' annotations
for all four: another controller has its own for each.

## Tested

`test.sh` puts the base on a cluster and checks, through a port-forward, its version and
dashboard, that the command it hands out deploys an agent, an actor's events, and that a
machine's daemon enrols and stays connected. Then it deletes the pod, and checks that what the
server kept is there and the daemon connects again. CI runs it on kind.
