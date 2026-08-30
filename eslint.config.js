import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "dev-data/**",
      // Design system and screen prototype: working INPUT for the interface
      // phase, not application code. It is browser code (`window`, `document`,
      // `fetch`) written as `.jsx`, so this configuration, which is the
      // backend's, reports hundreds of undefined globals that mean nothing
      // here. What lands in `src/web/` gets ported to `.tsx` and IS linted.
      "mychat-design-system/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
  },
  // Engine boundary (ADR-003), verified instead of agreed: the core stays free
  // of HTTP and of storage so it can be tested with no network and no database.
  // A pattern here is matched against the import specifier exactly as written,
  // so relative escapes such as `../storage/db` are caught too.
  {
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)(http|storage)(/|$)",
              message:
                "Engine boundary (ADR-003): src/engine must not import from src/http or src/storage. The engine receives plain data and ports injected from outside (see src/engine/ports.ts), which is what keeps it testable with no network and no concrete storage. Declare a port here and wire the concrete implementation in the layer that owns it.",
            },
            {
              group: [
                "fastify",
                "@fastify/*",
                "drizzle-orm",
                "drizzle-kit",
                "better-sqlite3",
                "node:sqlite",
                "node:http",
                "node:https",
                "node:net",
                "node:tls",
                "aws-sdk",
                "@aws-sdk/*",
                "@smithy/*",
                "minio",
              ],
              message:
                "Engine boundary (ADR-003): src/engine must not import a transport or persistence library (Fastify, Drizzle, SQLite, node HTTP or socket modules, S3 clients). The engine talks to the outside only through injected ports (see src/engine/ports.ts); the adapter that owns the library lives outside the engine.",
            },
          ],
        },
      ],
    },
  },
);
