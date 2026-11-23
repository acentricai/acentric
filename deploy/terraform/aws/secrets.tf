# The secrets key and the first admin key, made once and kept in Parameter Store, encrypted:
# off the instance, so that a server made again, or one a backup is put back on, has them. They
# are in Terraform's state too: keep the state where only those who run the server read it.

resource "random_bytes" "secret_key" {
  length = 32
}

resource "random_password" "admin_key" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "secret_key" {
  name        = "/${var.name}/secret-key"
  description = "ACENTRIC_SECRET_KEY: what agents' secrets and model accounts' keys are sealed with"
  type        = "SecureString"
  value       = random_bytes.secret_key.hex
}

resource "aws_ssm_parameter" "admin_key" {
  name        = "/${var.name}/admin-key"
  description = "ACENTRIC_ADMIN_KEY: an API key that may do everything"
  type        = "SecureString"
  value       = random_password.admin_key.result
}
