import type { PublicAllowlist } from "./public-release.js";

type GitResult = { status: number | null; stdout: string };
type GitRunner = (
  args: string[],
  options?: { allowFailure?: boolean; cwd?: string },
) => GitResult;

export function publishPublicRelease(options: {
  config: PublicAllowlist;
  git?: GitRunner;
  publicDir: string;
  sourceDir?: string;
  synchronize?: (source: string, destination: string) => void;
}): { files: string[]; published: boolean };
