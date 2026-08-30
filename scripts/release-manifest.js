/* global console, process */

import { fileURLToPath } from "node:url";

const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/i;
const repositoryPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export function createReleaseManifest({
  createdAt,
  repository,
  revision,
  tag,
}) {
  if (!stableTagPattern.test(tag)) {
    throw new Error(
      `release tag must be a stable vMAJOR.MINOR.PATCH tag: ${tag}`,
    );
  }
  if (!repositoryPattern.test(repository)) {
    throw new Error(`release repository must be owner/name: ${repository}`);
  }
  if (!shaPattern.test(revision)) {
    throw new Error("release revision must be a 40-character git SHA");
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error("release creation time must be an ISO-8601 timestamp");
  }

  const image = `ghcr.io/${repository.toLowerCase()}:${tag}`;
  return {
    image,
    platforms: ["linux/amd64", "linux/arm64"],
    provenance: {
      revision: revision.toLowerCase(),
      source: `https://github.com/${repository}`,
    },
    release: {
      createdAt: new Date(createdAt).toISOString(),
      tag,
    },
    schemaVersion: 1,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, repository, revision, createdAt = new Date().toISOString()] =
    process.argv.slice(2);
  console.log(
    JSON.stringify(
      createReleaseManifest({ createdAt, repository, revision, tag }),
      null,
      2,
    ),
  );
}
