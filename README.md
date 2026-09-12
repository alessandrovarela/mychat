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
2. Keep `.env` for infrastructure only (port and data directories). Do not put
   Meta credentials, webhook tokens, public addresses, or storage credentials
   in it for a new installation.
3. Start the released image with `docker compose up -d`, then check it with
   `docker compose ps --status running`.
4. Open MyChat and finish the first wizard. Then configure Webhook → Meta →
   Storage in Integrations; credentials are encrypted by the instance and never
   shown again.
5. Keep `mychat-data`. Do not use `docker compose down -v` unless deleting the
   instance's data is intentional.

For the guided, repeatable local plan see
[the installation guide](docs/installing.md). The installer preserves an
existing `.env` and volume on a safe re-run.

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

For the Instagram Login setup walkthrough, see the
[pt-BR Meta setup guide](docs/meta-app-setup.md) or the
[English Meta setup guide](docs/meta-app-setup.en.md).
