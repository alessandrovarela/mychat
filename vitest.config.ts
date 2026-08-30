import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two projects, because the code under test runs in two different worlds.
 *
 * The backend is a Node process and must be tested as one: a suite that ran
 * everything in jsdom would give `src/storage` and `src/http` a `document` and
 * a `window` they will never have in production, and the double would hide the
 * very defects the fast suite exists to catch.
 *
 * The interface is the opposite case: it needs a DOM, and the gate cannot
 * download a browser to get one (ADR-017 keeps the commit gate fast, ADR-018
 * keeps it free of containers). So `src/web` runs in the emulated DOM and
 * nothing else does.
 *
 * A separate file from `vite.config.ts` on purpose: that config sets `root` to
 * `src/web` for the bundle, and inheriting it here would point the whole suite
 * at the interface directory.
 */
/**
 * Why every project declares `testTimeout`, and why it is not the default.
 *
 * Vitest defaults to 5000ms per test. This suite runs 85 files across TWO
 * projects, each opening a worker per core, so the slowest cases compete for
 * CPU with dozens of siblings. Measured on 2026-08-20: a case that takes
 * 530ms alone took 5491ms under the full suite and lost. Across four
 * consecutive runs of an UNCHANGED tree the verdict was green, then three
 * failures, then three, then three, and the files that lost were different
 * every time. Every failure was `Test timed out`, never an assertion.
 *
 * A gate whose verdict is decided by scheduling reports something false, and
 * this one blocked a documentation-only commit four times. The floor is set
 * high enough that the slowest case has roughly forty times its own runtime,
 * which is the headroom the KEEL asks for. It still catches a real hang: a
 * test that deadlocks never finishes, whatever the budget.
 *
 * Declared per project because `projects` entries do not inherit the root
 * `test` block.
 */
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          testTimeout: TEST_TIMEOUT_MS,
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          // `src/web` is listed beside the defaults, not instead of them:
          // setting `exclude` replaces the built-in list wholesale.
          exclude: ["**/node_modules/**", "**/dist/**", "src/web/**"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          testTimeout: TEST_TIMEOUT_MS,
          include: ["src/web/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/web/test-setup.ts"],
          // Vitest replaces every CSS file with an EMPTY module unless this is
          // on, and `src/web/styles/tokens.test.ts` reads the real stylesheets:
          // it hunts literals through them and computes the contrast of the
          // palette they declare. Stubbed to empty, both guardians would find
          // nothing and report success, which is the worst way for a check to
          // fail. Nothing else here imports CSS, so this costs one read of the
          // token sheet.
          css: true,
        },
      },
    ],
  },
});
