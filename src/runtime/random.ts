import type { RandomSource } from "../engine/ports.js";

/**
 * The real source of chance (REQ-126).
 *
 * One line, and it lives HERE rather than in the engine for the same reason the
 * clock does: `Math.random()` is an outside effect, and an engine that called it
 * could not be asked which wording it was about to draw. Out here it is an
 * adapter like any other, wired once at the composition root and replaced by a
 * scripted one in every test that has an expectation about the draw.
 *
 * No seed, deliberately. A reproducible generator would only move the question
 * of who decides the sequence one layer out, and the tests that care already
 * pass their own source.
 */
export function createRandomSource(): RandomSource {
  return { next: (): number => Math.random() };
}
