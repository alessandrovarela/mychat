# Releasing MyChat

The public repository is derived from the private working repository through the
explicit allow-list in `config/public-allowlist.json`. Never copy the private
tree wholesale and never publish `.helmit`, local data, `.env` files, internal
handoffs, or design/process documents.

## Prepare the public tree

Check that `origin` is the private source and `public` is the distinct public
destination. Then derive a fresh public directory:

```sh
node scripts/public-release.js . ../mychat-public
```

Review that generated directory before committing or pushing it. The exporter
rejects symlinks, files outside the allow-list, and recognizable credentials.

## Release a stable version

Only a pushed Git tag in the form `vMAJOR.MINOR.PATCH` starts the release
workflow. It runs the test, build, and lint gates; publishes the Linux AMD64
and ARM64 image to GHCR; creates an attested release manifest; and produces
GitHub release notes.

The image is `ghcr.io/<owner>/mychat:<tag>`. Docker Compose uses `:latest` for
normal installs; pin an explicit stable tag when a reproducible deployment is
required. The release workflow does not merge pull requests or provision a
domain, VM, or external application credentials.
