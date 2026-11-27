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
  --from-literal=secret-key="$(openssl rand -hex 32)" \
  --from-literal=admin-key="$(openssl rand -hex 24)"
```

The server reads them as files of that Secret, mounted for its group alone, not as variables
of its environment. Keep a copy of the secrets key somewhere other than the cluster. In a folder of your own, a
`kustomization.yaml` that takes one of these and sets the version and the address:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://github.com/acentricai/acentric//deploy/kubernetes/gateway?ref=v0.19.0
images:
  - name: ghcr.io/acentricai/acentric-server
    newTag: 0.19.0
configMapGenerator:
  - name: acentric-settings
    behavior: merge
    literals:
      - ACENTRIC_PUBLIC_URL=https://engine.example.com
```

With the Gateway's name and namespace, and the name people use, set in a patch of the
HTTPRoute (or the Ingress's host, class and certificate): `kubectl apply -k .`. The setup link
is in `kubectl -n acentric logs acentric-0`.

## Backups

The server backs itself up every day, and before an upgrade, onto its volume `backups`
([BACKUPS.md](../../BACKUPS.md)). A backup to keep outside the cluster:

```sh
kubectl -n acentric exec acentric-0 -- acentric-server backup > "acentric-$(date -u +%F).tar"
```

To have each copied to a bucket as well, off the cluster, add `ACENTRIC_BACKUP_URL` (such as
`s3://my-bucket/acentric`) and `AWS_REGION` to the settings in a `configMapGenerator` patch. The
server reaches the bucket with the pod's identity on EKS (IRSA or Pod Identity, with a
ServiceAccount of your own), or with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from a
Secret of your own, given to the container by `envFrom` in a patch; at another store, `AWS_ENDPOINT_URL_S3` too. What the key may do is
in [BACKUPS.md](../../BACKUPS.md#a-bucket). One there is put back as below, with its
`s3://` URL after `restore` and no stdin.

To put one back: stop the server, and run the restore in a pod of its own on the server's volume,
with the backup on its stdin.

```sh
kubectl -n acentric scale statefulset/acentric --replicas=0
kubectl -n acentric wait --for=delete pod/acentric-0
kubectl -n acentric run acentric-restore --rm -i --restart=Never \
  --image=ghcr.io/acentricai/acentric-server:0.19.0 --overrides='{
    "spec": {
      "enableServiceLinks": false,
      "securityContext": { "runAsNonRoot": true, "runAsUser": 1000, "fsGroup": 1000 },
      "volumes": [
        { "name": "data", "persistentVolumeClaim": { "claimName": "data-acentric-0" } },
        { "name": "secrets", "secret": { "secretName": "acentric-secrets", "defaultMode": 288 } }
      ],
      "containers": [{
        "name": "acentric-restore", "image": "ghcr.io/acentricai/acentric-server:0.19.0",
        "stdin": true, "stdinOnce": true, "command": ["acentric-server", "restore"],
        "env": [{ "name": "ACENTRIC_SECRET_KEY_FILE", "value": "/run/secrets/acentric/secret-key" }],
        "volumeMounts": [
          { "name": "data", "mountPath": "/data" },
          { "name": "secrets", "mountPath": "/run/secrets/acentric", "readOnly": true }
        ]
      }]
    }
  }' < acentric-2026-11-23.tar
kubectl -n acentric scale statefulset/acentric --replicas=1
```

## Upgrading

Read the new version's notes in [CHANGELOG.md](../../CHANGELOG.md), and which versions it goes
to at once ([VERSIONS.md](../../VERSIONS.md#from-which-version-to-which)). Then set the new
version in your `kustomization.yaml`, in the resource's `?ref=` and in `newTag` alike, so that
the recipe and the image are of one version, and:

```sh
kubectl apply -k .
kubectl -n acentric rollout status statefulset/acentric --timeout=30m
kubectl -n acentric logs -f acentric-0
```

The StatefulSet stops the server, and starts the new version on its volume. A version that
changes the database backs it up first, then changes it: its log says each. Meanwhile the pod
is live and not ready, so the Service sends it nothing and the probes leave it be, however long
it takes. It is done when the pod is ready, and its log says `acentric-server <version>
listening`. [What an upgrade looks like](../../VERSIONS.md#what-an-upgrade-looks-like) says what
it writes, and how long it takes.

To go back, put back the backup it took before it changed the database, with the version you
had. Its name ends `-before-upgrade-<new version>.tar`, on the volume `backups-acentric-0`
(`kubectl -n acentric exec acentric-0 -- ls /backups`), or in the bucket. Set the version back
in `kustomization.yaml` and apply it; the pod of that version does not start on the changed
database, and says so. Then put the backup back as above, with the image of the version you
had: by its URL in the bucket, or with the claim `backups-acentric-0` mounted at `/backups` in
the restore's pod and the backup's path after `restore` in place of stdin.

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
server kept is there and the daemon connects again; and takes a backup, and puts it back as
above. CI runs it on kind.
