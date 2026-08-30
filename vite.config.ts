import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/**
 * The SPA build (REQ-105): `src/web` in, a directory of plain files out, served
 * by the same Fastify process that answers the webhook (ADR-004).
 *
 * There is no development server in production. `npm start` runs the Node
 * process and `src/http/static.ts` reads THIS build's output from disk; `vite`
 * (the `dev:web` script) exists only on a developer's machine and is never part
 * of the running application.
 */

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = fileURLToPath(new URL("src/web", import.meta.url));
const webTsconfig = fileURLToPath(
  new URL("src/web/tsconfig.json", import.meta.url),
);

/**
 * Where the bundle's hashed files land, and why it is not the Vite default.
 *
 * The default is `assets/`, and `/assets` is already taken: it is the public
 * route the platform fetches uploaded resources from (ASSETS_ROUTE_PREFIX in
 * `src/http/assets-route.ts`). That route is registered as `/assets/*` and wins
 * over the SPA fallback by specificity, so with the default every script and
 * stylesheet of the interface would answer 404 while the build looked perfect.
 * `src/http/static.test.ts` asserts the two addresses stay apart.
 */
const WEB_ASSETS_DIR = "app";

/**
 * Where the development proxy points when PORT is not set. It mirrors the
 * default in `src/config/env.ts`, which is not exported; if that default ever
 * changes, this one has to follow. Development only, and it fails loudly (the
 * browser reports a refused connection), never silently.
 */
const DEFAULT_API_PORT = "3000";

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => projectRoot,
  getNewLine: () => ts.sys.newLine,
};

/**
 * Typechecks `src/web` before bundling.
 *
 * Vite only transpiles: it strips the types and never reads them, so without
 * this the SPA would be the one part of the codebase that no gate checks. It
 * cannot be folded into the root `tsc --noEmit` either, because that program
 * deliberately has no DOM (see `tsconfig.json`), and a program has one `lib`.
 * So the check that belongs to the SPA runs with the SPA's build.
 */
function typecheckWeb(): Plugin {
  return {
    name: "mychat:typecheck-web",
    // Only on `vite build`. The dev server answers on every keystroke, and the
    // editor already reports the same diagnostics there.
    apply: "build",
    buildStart() {
      const host: ts.ParseConfigFileHost = {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost),
          );
        },
      };

      const parsed = ts.getParsedCommandLineOfConfigFile(
        webTsconfig,
        undefined,
        host,
      );

      if (parsed === undefined) {
        // Unreachable while the file is in the repository, and worth saying out
        // loud anyway: a build that cannot read the program is a build that
        // checked nothing, and must not look like a build that found no errors.
        throw new Error(`unreadable TypeScript program: ${webTsconfig}`);
      }

      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = [
        ...parsed.errors,
        ...ts.getPreEmitDiagnostics(program),
      ];

      if (diagnostics.length > 0) {
        this.error(
          ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost),
        );
      }
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [react(), typecheckWeb()],
  server: {
    // Development only, and it is what keeps `npm run dev:web` from needing a
    // second origin: the interface is loaded from Vite while `/api` is answered
    // by the Node process that `npm run dev` started, on the PORT that process
    // reads from the environment.
    proxy: {
      "/api": `http://127.0.0.1:${process.env["PORT"] ?? DEFAULT_API_PORT}`,
    },
  },
  build: {
    // Outside the Vite root on purpose: the process serves this directory, and
    // `src/http/static.ts` resolves the same path from the repository root.
    // `src/http/static.test.ts` compares the two, so they cannot drift apart.
    outDir: fileURLToPath(new URL("dist/web", import.meta.url)),
    emptyOutDir: true,
    assetsDir: WEB_ASSETS_DIR,
  },
});
