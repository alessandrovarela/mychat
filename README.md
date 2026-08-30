# MyChat

MyChat is a self-hosted automation service for one Instagram account. It keeps
the application, SQLite data and attachments on your own host. A new
installation can be explored without Meta credentials, but a draft saved
locally is not evidence that Meta received an event or that a message was
delivered.

[Leia em português do Brasil](README.pt-BR.md).

## Install

Use Ubuntu LTS 22.04 or 24.04 on `amd64` or `arm64`. Keep recoverable SSH
access and space for the persistent `mychat-data` volume.

1. Download the released `docker-compose.yml` and `.env.example` into a new,
   private directory. Copy `.env.example` to `.env`; never commit or share the
   resulting `.env`.
2. Generate unique values for `META_APP_SECRET` and `WEBHOOK_VERIFY_TOKEN` on
   the host, then put the values only in `.env`. Do not paste a token into a
   shell history, issue tracker, chat, or screenshot.
3. Start the released image with `docker compose up -d`, then check it with
   `docker compose ps --status running`.
4. Keep `mychat-data`. Do not use `docker compose down -v` unless deleting the
   instance's data is intentional.

For the guided, repeatable local plan see
[the installation guide](docs/installing.md). The installer preserves an
existing `.env` and volume on a safe re-run; it asks before replacing a secret.

## First automation

Choose one path deliberately:

- **Local, no Meta:** open the local panel, create a simple automation and
  save it as a draft. The expected result is `local draft`; it proves only
  local persistence and sends nothing to Meta.
- **Real Meta integration:** configure Meta first, then use a separate test
  account to produce an event. Record three pieces of evidence: event receipt,
  automation execution, and the result received by the second account. This
  external verification is scheduled for Phase 4e.

The detailed first-use guide is [docs/first-use.md](docs/first-use.md).

## Meta authentication

MyChat has two distinct authentication paths. Start with **Instagram Login**
unless you already operate a Meta business portfolio and specifically need the
optional **system user** path. They are not interchangeable: their API hosts,
comment permissions, and token lifetimes differ. The application uses one
`PlatformAccount` contract after the path is selected, so flow and delivery
logic must not branch on credentials.

Read [the authentication guide](docs/authentication.md) before entering any
credential. Keep `/webhook` public: an external authentication layer must
explicitly bypass it, or Meta deliveries silently stop.

For the Instagram Login setup walkthrough, see
[the Meta setup guide](docs/meta-app-setup.md).
