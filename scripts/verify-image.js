/* global URL, console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const dockerfilePath = resolve(projectRoot, "Dockerfile");

export function inspectProductionImage(source) {
  const required = [
    "FROM node:24-trixie-slim AS build",
    "FROM node:24-trixie-slim AS production-dependencies",
    "FROM node:24-trixie-slim AS runtime",
    "python3 make g++",
    "npm ci --omit=dev",
    "npx tsc --noEmit false --outDir build",
    "COPY --from=build --chown=node:node /app/build ./build",
    "COPY --from=build --chown=node:node /app/dist ./build/dist",
    "COPY --from=build --chown=node:node /app/src/i18n/locales ./build/src/i18n/locales",
    "COPY --chown=node:node drizzle ./build/drizzle",
    "USER node",
    'CMD ["node", "build/src/main.js"]',
  ];

  const missing = required.filter((line) => !source.includes(line));
  const forbidden = ["COPY . .", "tsx", "npm install"].filter((line) =>
    source.includes(line),
  );

  return { missing, forbidden };
}

export function verifyProductionImage(path = dockerfilePath) {
  const source = readFileSync(path, "utf8");
  const result = inspectProductionImage(source);

  if (result.missing.length > 0 || result.forbidden.length > 0) {
    const details = [
      result.missing.length > 0 && `missing: ${result.missing.join(", ")}`,
      result.forbidden.length > 0 &&
        `forbidden: ${result.forbidden.join(", ")}`,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`production image contract failed: ${details}`);
  }

  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyProductionImage();
  console.log("production image contract: ok");
}
