# The Acentric server on one EC2 instance, behind Caddy, with its data on a volume of its own
# that outlives the instance, snapshots of that volume every day, and its backups copied to a
# bucket. How to use it is in README.md beside this file.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6, < 4.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      "acentric:name" = var.name
    }
  }
}
