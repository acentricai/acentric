output "url" {
  description = "Where people, the acentric command and machines reach the server."
  value       = "https://${local.domain}"
}

output "ip" {
  description = "The server's address, which domain points at."
  value       = aws_eip.server.public_ip
}

output "instance_id" {
  description = "The instance, for Session Manager: aws ssm start-session --target <it>."
  value       = aws_instance.server.id
}

output "backup_url" {
  description = "Where in the bucket the server's backups are copied to."
  value       = "s3://${aws_s3_bucket.backups.bucket}/acentric"
}

output "data_volume_id" {
  description = "The volume everything the server keeps is on, which is snapshotted every day."
  value       = aws_ebs_volume.data.id
}

output "admin_key_command" {
  description = "Says the API key that may do everything."
  value       = "aws ssm get-parameter --region ${var.region} --name ${aws_ssm_parameter.admin_key.name} --with-decryption --query Parameter.Value --output text"
}

output "secret_key_command" {
  description = "Says the secrets key, for a copy kept somewhere other than this account."
  value       = "aws ssm get-parameter --region ${var.region} --name ${aws_ssm_parameter.secret_key.name} --with-decryption --query Parameter.Value --output text"
}

output "setup_link_command" {
  description = "Says the link that makes the server's owner, once it has started."
  value       = "aws ssm send-command --region ${var.region} --instance-ids ${aws_instance.server.id} --document-name AWS-RunShellScript --parameters 'commands=[\"journalctl -u acentric --no-pager | grep -m1 setup\"]' --query Command.CommandId --output text"
}
