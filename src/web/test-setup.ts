/**
 * Loaded before every test of the `web` project (see `vitest.config.ts`).
 *
 * It registers the DOM matchers on Vitest's `expect`, so a screen test asserts
 * what the operator would see (`toBeInTheDocument`, `toBeVisible`) instead of
 * poking at node properties.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmounts what a test rendered, before the next one renders.
 *
 * The automatic cleanup of Testing Library only arms itself when Vitest runs
 * with global APIs, and this project imports them explicitly. Without this, a
 * second `render` in the same file leaves the first tree in the document and
 * every query by role or by text finds two of everything, which reads as a
 * mysterious "found multiple elements" in a test that did nothing wrong.
 */
afterEach(cleanup);
