import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectProductionImage,
  verifyProductionImage,
} from "../../scripts/verify-image.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("production image", () => {
  it("ships compiled code and production dependencies under the unprivileged user", () => {
    expect(verifyProductionImage()).toEqual({ missing: [], forbidden: [] });
  });

  it("places the web bundle where the compiled static route resolves it", () => {
    const source = readFileSync(resolve(projectRoot, "Dockerfile"), "utf8");

    expect(source).toContain(
      "COPY --from=build --chown=node:node /app/dist ./build/dist",
    );
  });

  it("rejects a Dockerfile that reintroduces development runtime tooling", () => {
    const source = readFileSync(resolve(projectRoot, "Dockerfile"), "utf8");
    const sabotaged = source.replace(
      'CMD ["node", "build/src/main.js"]',
      'CMD ["tsx", "src/main.ts"]',
    );

    expect(inspectProductionImage(sabotaged).forbidden).toContain("tsx");
  });
});
