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

## Protect the public branch

In the public GitHub repository, create a branch protection rule for `main`:

1. Restrict pushes to the dedicated release identity only. Do not grant this
   permission to the account used for ordinary development.
2. Require the `check` CI workflow to pass before a change is merged.
3. Block force pushes and branch deletion.

The release identity needs access only to the public repository. Keep it out of
the private repository, do not place its credential in this project, and never
use a personal development credential for the publication flow.

## Publish the derived tree

Keep a clean checkout of the public repository on its `main` branch. From the
private checkout, run:

```sh
npm run publish:public -- /absolute/path/to/mychat-public
```

Before changing the public checkout, the command verifies that the private
checkout is on `main`, that its `origin` and `public` remotes match the
configured repository names, and that the destination checkout is clean and
points to the expected public remote. It then derives the allow-listed tree,
commits it in the public checkout only when it changed, and pushes `main`.

If any check fails, stop and correct the reported condition. Do not use force
push, copy files manually, or bypass the branch protection rule.

## Release a stable version

Only a pushed Git tag in the form `vMAJOR.MINOR.PATCH` starts the release
workflow. It runs the test, build, and lint gates; publishes the Linux AMD64
and ARM64 image to GHCR; creates an attested release manifest; and produces
GitHub release notes.

The image is `ghcr.io/<owner>/mychat:<tag>`. Docker Compose uses `:latest` for
normal installs; pin an explicit stable tag when a reproducible deployment is
required. The release workflow does not merge pull requests or provision a
domain, VM, or external application credentials.
