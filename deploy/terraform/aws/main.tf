data "aws_availability_zones" "here" {
  state = "available"
}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.architecture}"
}

locals {
  zone   = coalesce(var.availability_zone, data.aws_availability_zones.here.names[0])
  domain = coalesce(var.domain, "${replace(aws_eip.server.public_ip, ".", "-")}.sslip.io")
}

# A network of its own: one public subnet, and no NAT gateway to pay for.

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone = local.zone
  tags              = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# HTTP, for Caddy to get its certificate and send people to HTTPS, and HTTPS, over TCP and
# QUIC. No SSH: the instance is reached by Session Manager.
resource "aws_security_group" "server" {
  name        = var.name
  description = "Acentric: HTTP and HTTPS in, anything out"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = var.name }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = {
    http  = { port = 80, protocol = "tcp" }
    https = { port = 443, protocol = "tcp" }
    quic  = { port = 443, protocol = "udp" }
  }
  security_group_id = aws_security_group.server.id
  description       = each.key
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = each.value.protocol
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.server.id
  description       = "anything out"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# The address people reach it at, which stays when the instance is made again.
resource "aws_eip" "server" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_eip_association" "server" {
  instance_id   = aws_instance.server.id
  allocation_id = aws_eip.server.id
}

resource "aws_route53_record" "server" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = local.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}

# The instance: Amazon Linux 2023, Docker, the server as the systemd recipe runs it, and Caddy
# in front. It is made again when what it starts with changes, such as the version: what the
# server keeps is on the data volume, which is not.
resource "aws_instance" "server" {
  ami                    = data.aws_ssm_parameter.ami.insecure_value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.server.id]
  iam_instance_profile   = aws_iam_instance_profile.server.name
  # Its address is the elastic one; this one is only until that is associated.
  associate_public_ip_address = true

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    version      = var.acentric_version
    public_url   = "https://${local.domain}"
    domain       = local.domain
    volume_id    = aws_ebs_volume.data.id
    secret_key   = aws_ssm_parameter.secret_key.name
    admin_key    = aws_ssm_parameter.admin_key.name
    backup_url   = "s3://${aws_s3_bucket.backups.bucket}/acentric"
    backup_every = var.backup_every
    backup_keep  = var.backup_keep
    region       = var.region
    service      = file("${path.module}/../../systemd/acentric.service")
    caddyfile    = replace(file("${path.module}/../../systemd/Caddyfile"), "engine.example.com", local.domain)
    # As the Compose recipe's.
    caddy_version = "2.11.8"
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required"
    # The server's container reaches the instance's role through Docker's bridge: one hop more.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  tags = { Name = var.name }

  lifecycle {
    # A newer Amazon Linux is taken when the instance is made again for another reason.
    ignore_changes = [ami]
  }
}

# Everything the server keeps, on a volume of its own: Docker's own folder, with the server's
# volumes in it. It is not removed when the instance is made again.
resource "aws_ebs_volume" "data" {
  availability_zone = local.zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  final_snapshot    = true
  tags              = { Name = "${var.name}-data", "acentric:snapshots" = var.name }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.server.id
  # The instance is stopped first, so that the server stops as it does and the volume is
  # whole when it goes to the next one.
  stop_instance_before_detaching = true
}

# A snapshot of the data volume every day, the newest snapshot_days kept: the whole disk, as it
# was, beside the server's own backups.
resource "aws_dlm_lifecycle_policy" "snapshots" {
  description        = "${var.name}: the data volume, every day"
  execution_role_arn = aws_iam_role.snapshots.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { "acentric:snapshots" = var.name }

    schedule {
      name      = "daily"
      copy_tags = true
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule {
        count = var.snapshot_days
      }
    }
  }
}
