export interface ReleaseManifest {
  image: string;
  platforms: ["linux/amd64", "linux/arm64"];
  provenance: {
    revision: string;
    source: string;
  };
  release: {
    createdAt: string;
    tag: string;
  };
  schemaVersion: 1;
}

export function createReleaseManifest(input: {
  createdAt: string;
  repository: string;
  revision: string;
  tag: string;
}): ReleaseManifest;
