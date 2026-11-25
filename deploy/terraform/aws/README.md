# Terraform: AWS

The server on one EC2 instance in an account of yours, made with Terraform (or OpenTofu):

- **The instance**: Amazon Linux 2023 on Graviton (`t4g.medium`), running the server as the
  [systemd recipe](../../systemd/) does, by Docker, with Caddy in front, which gets and renews
  its HTTPS certificate. No SSH: it is reached by Session Manager.
- **Its data, on a volume of its own**: an encrypted gp3 volume that Docker's folder is on, the
  server's volumes in it. It is not removed when the instance is made again, and a snapshot is
  left of it when it is removed.
- **An address that stays**: an Elastic IP, and the record for your name in Route 53 when you
  give the zone.
- **Backups, three ways**: the server's own, every day and before an upgrade, on the volume and
  copied to a bucket of their own (private, encrypted, versioned, TLS only) by the instance's
  role; and a snapshot of the whole volume every day, by Data Lifecycle Manager.
- **The keys**: the secrets key and an admin API key, made once and kept in Parameter Store,
  encrypted, off the instance; on it, files the server reads, not settings of its environment.
- **A network of its own**: a VPC with one public subnet, HTTP and HTTPS in, and no NAT
  gateway.

About $35 a month in `us-east-1` with the defaults, most of it the instance.

## Making it

```sh
cp terraform.tfvars.example terraform.tfvars   # the region, and your name for it
terraform init
terraform apply
```

Point the name at `ip` (unless Route 53 does), and Caddy gets the certificate once it does.
Then:

```sh
terraform output url
sh -c "$(terraform output -raw admin_key_command)"    # the key that may do everything
```

The link that makes the server's owner is in its log, by Session Manager:
`aws ssm start-session --target "$(terraform output -raw instance_id)"`, then
`sudo journalctl -u acentric | grep setup`.

**Keep a copy of the secrets key** somewhere other than this account
(`terraform output -raw secret_key_command`): without it, the secrets in a backup do not open.

**Terraform's state has both keys in it.** Keep it where only those who run the server read it:
a backend of S3 with encryption, or Terraform Cloud, rather than a file on a laptop.

## Upgrading

Read the new version's notes in [CHANGELOG.md](../../../CHANGELOG.md), and which versions it
goes to at once ([VERSIONS.md](../../../VERSIONS.md#from-which-version-to-which)). When its notes
say this recipe changed, take this folder from its tag, keeping `terraform.tfvars` and the
state.

Set `acentric_version`, and `terraform apply`. The instance is made again with it: it is
stopped first, so that the server stops as it does, its volume goes to the new one, and the new
version backs the database up before it changes it, to its backups' folder and the bucket. The
server is away for a few minutes, and more for a large database ([What an upgrade looks
like](../../../VERSIONS.md#what-an-upgrade-looks-like)). It is done when
`curl -s "$(terraform output -raw url)/health"` answers `"ok":true` with the new version; on the
instance, `sudo journalctl -u acentric -f` says what it is doing.

To go back, set `acentric_version` back and `terraform apply`: the version you had does not
start on the changed database, and says so. Then, on the instance, put back the backup taken
before the upgrade, whose name ends `-before-upgrade-<new version>.tar`, as below, by its URL in
the bucket.

## Putting a backup back

By Session Manager, on the instance, with the server stopped, and the URL of the backup in
the bucket (`terraform output backup_url`, then its name):

```sh
sudo systemctl stop acentric
sudo docker run --rm --env-file /etc/acentric/acentric.env --volume acentric-data:/data \
  --volume /etc/acentric/secrets/secret-key:/run/secrets/acentric/secret-key:ro \
  --volume /etc/acentric/secrets/admin-key:/run/secrets/acentric/admin-key:ro \
  ghcr.io/acentricai/acentric-server:0.18.0 acentric-server restore s3://<bucket>/acentric/<name>.tar
sudo systemctl start acentric
```

The names are in `aws s3 ls "$(terraform output -raw backup_url)/"`, and in the Backups section of the dashboard's Settings.
A lost volume is made again from its newest snapshot, or the instance is made with a new one
and the newest backup in the bucket put back on it.

## Removing it

`terraform destroy` removes all of it but the bucket while it has backups in it
(`bucket_force_destroy` removes that too) and the data volume's last snapshot.

## Tested

`test.sh` makes it in an account, waits for its certificate from Let's Encrypt for
`<ip>.sslip.io`, checks the server's version, its dashboard and scripts, that a backup is in the
bucket by the instance's role, that the instance made again has what the server kept, and that
the snapshots are scheduled; then removes all of it, the data volume's last snapshot too. It is run by hand, with an account's
credentials; CI checks that the recipe is well formed.
