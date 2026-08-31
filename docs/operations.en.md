# MyChat operations

This is a preparation runbook for a published instance. Do not execute external
actions in this phase: buying a domain or VM, opening an R2 account, creating a
bucket, changing DNS, issuing a certificate, or Meta verification belongs to
Phase 4e. Replace `<...>` placeholders only when that phase is authorised.

## 1. Infrastructure, domain, and HTTPS

**Prerequisites:** a selected Ubuntu LTS VM, recoverable SSH access, a domain
you control, ports 80 and 443 open, and an `.env` preserved outside the repo.

**Future procedure:** point `<domain>` DNS to the VM IPv4, place Caddy in front
of `127.0.0.1:3000`, and set `PUBLIC_ORIGIN=https://<domain>`. Caddy's
[automatic HTTPS](https://caddyserver.com/docs/automatic-https) needs a domain
name and public reachability to obtain and renew a certificate. Set
`AUTH_TRUSTED_PROXY_HOPS=1`; never put an authentication layer in front of
`/webhook`.

**Expected outcome:** `https://<domain>` serves the application, the certificate
is valid, and `https://<domain>/webhook` remains reachable by Meta.

**Recovery:** if certificate issuance fails, check DNS, ports, and proxy logs;
do not disable TLS or publicly expose the application port. If the webhook sees
authentication, restore its `/webhook` bypass before retrying. External
execution and verification are deferred to Phase 4e.

## 2. R2 and continuous backup

**Prerequisites:** an operator-created private R2 bucket, least-privilege
credentials, S3 endpoint, retention policy, and `.env` backed up in a vault.
Review [R2 pricing](https://developers.cloudflare.com/r2/pricing/) before
creating data or lifecycle rules.

**Future procedure:** configure Litestream to replicate
`/var/lib/mychat/mychat.db` to an isolated bucket prefix, following the
[Litestream S3 guide](https://litestream.io/guides/s3/). Keep `assets/` and
`thumbs/` separate from database replicas and record retention.

**Expected outcome:** Litestream reports a recent replica and the
`mychat-data` volume remains the working local copy.

**Recovery:** if replication fails, stop changes and inspect endpoint,
credentials, clock, permissions, and logs. Do not delete the volume or bucket
as the first response. Actual bucket creation and backup proof are Phase 4e.

## 3. Testable restore

**Prerequisites:** a known replica, maintenance window, preserved original
volume, and an empty restore directory outside production.

**Future procedure:** restore first into `<test-directory>` using the recorded
Litestream version, open the restored SQLite copy, and check migrations and
integrity before replacing any volume.

**Expected outcome:** the restored copy opens, has data from the intended point,
and production remains unchanged.

**Recovery:** when validation fails, discard only the test copy, preserve the
original volume and replica, and investigate logs or credentials. Never replace
`mychat-data` with an unverified restore. External execution is Phase 4e.

## 4. Update and rollback

**Prerequisites:** a known release tag, healthy backup, maintenance window, and
recorded current version. The automated update and rollback mechanism arrives in
Phase 4d; until then this is an operations contract only.

**Future procedure:** pin a release tag in `docker-compose.yml`, obtain the
image, apply the update, then observe logs and health. Never use `latest` as the
only record of the deployed version.

**Expected outcome:** version and digest are recorded, the process is healthy,
and data is preserved.

**Recovery:** stop progression, keep the volume, return to the previous
tag/digest only using the Phase 4d validated procedure, and investigate before
retrying. Do not blindly downgrade after a migration.

## 5. Diagnostics

**Prerequisites:** SSH access, version/digest identification, proxy and service
logs, and no credential pasted into a shared terminal or ticket.

**Future procedure:** inspect `docker compose ps`, `docker compose logs app`,
and `npm run cli -- status` in the instance's safe context. Classify the issue
as process, volume, proxy/TLS, R2/Litestream, or Meta credentials.

**Expected outcome:** diagnostics identify the component, evidence, reversible
action, and resume point.

**Recovery:** make one change at a time, record time and version, and return to
the last healthy state when a validated procedure exists. Do not run destructive
commands, recreate a volume, or reveal secrets. Real-VM collection is deferred
to Phase 4e.
