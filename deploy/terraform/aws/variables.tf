variable "region" {
  description = "The AWS region it is made in, such as eu-west-1."
  type        = string
}

variable "name" {
  description = "What its resources are named and tagged with: one name for each server in an account."
  type        = string
  default     = "acentric"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "name is lower-case letters, digits and dashes, from 3 to 32 of them, starting with a letter."
  }
}

variable "acentric_version" {
  description = "The version of the server, as VERSIONS.md says: an exact one, changed on purpose. Changing it makes the instance again, on the same data volume, and the new version backs the database up before it changes it."
  type        = string
  default     = "0.16.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.acentric_version))
    error_message = "acentric_version is an exact version, such as 0.15.0."
  }
}

variable "domain" {
  description = "The name people reach the server at, such as engine.example.com, which points at the server's address (the output ip). Without it, <ip>.sslip.io: for trying it out."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "A Route 53 hosted zone that has domain in it: with it, the record that points domain at the server is made there too."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "The instance's type. An Arm (Graviton) one, as the image is built for arm64 and amd64 and Arm costs less."
  type        = string
  default     = "t4g.medium"
}

variable "architecture" {
  description = "arm64 for an Arm instance type (t4g, m7g, …), x86_64 for another (t3, m7i, …)."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture is arm64 or x86_64."
  }
}

variable "data_volume_gb" {
  description = "The size of the volume everything the server keeps is on, its local backups too, in GB. It can be made larger later, never smaller."
  type        = number
  default     = 40
}

variable "snapshot_days" {
  description = "How many daily snapshots of the data volume are kept."
  type        = number
  default     = 7
}

variable "backup_every" {
  description = "How often the server backs itself up, such as 24h, 6h or 30m. Each is copied to the bucket."
  type        = string
  default     = "24h"
}

variable "backup_keep" {
  description = "How many of the server's backups of each kind are kept, on the volume and in the bucket."
  type        = number
  default     = 7
}

variable "backup_versions_days" {
  description = "How many days a backup the server removed, or one written over, is kept in the bucket still, as an older version."
  type        = number
  default     = 30
}

variable "bucket_force_destroy" {
  description = "Whether `terraform destroy` removes the bucket with the backups in it. Without it, a bucket that has any is kept."
  type        = bool
  default     = false
}

variable "availability_zone" {
  description = "The zone the instance and its volume are in: the region's first without it. A volume stays in its zone."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "The addresses of the network made for it."
  type        = string
  default     = "10.42.0.0/16"
}
