export interface PublicAllowlist {
  allowedDirectories: string[];
  allowedFiles: string[];
  publicRemote: "public";
  publicRepository: string;
  sourceBranch: string;
  sourceRemote: "origin";
  sourceRepository: string;
}

export function assertRemoteTopology(
  remotes: Record<string, string | undefined>,
  config: PublicAllowlist,
): void;
export function assertPublicationContext(
  context: {
    branch: string;
    remotes: Record<string, string | undefined>;
  },
  config?: PublicAllowlist,
): void;
export function verifyPublicTree(
  root: string,
  config?: PublicAllowlist,
): string[];
export function preparePublicRelease(options: {
  config?: PublicAllowlist;
  outputDir: string;
  sourceDir?: string;
}): string[];
