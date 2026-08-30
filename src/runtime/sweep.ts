import type { Clock } from "../engine/ports.js";
import type { DurableWorkStore, WorkItem, WorkKind } from "../storage/index.js";

/**
 * The periodic sweep: the other half of ADR-005.
 *
 * It owns exactly one decision — which pending work is due — and delegates
 * everything else. What a piece of work MEANS is the handler's business; when a
 * deferred item comes back is the caller's. That is why this file names no
 * platform, no endpoint and no cap: the send adapter, the rate budget and the
 * suspension timeout all plug in as handlers without this module changing.
 *
 * Time arrives through the injected `Clock` (KEEL convention). No test in this
 * phase waits for real time to pass, which is the only reason a seven-day
 * window or a sixty-day token is testable at all.
 */

export type SweepOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly reason: string }
  /** Back to the queue at `dueAt`. A cap reached, or a retry being scheduled. */
  | { readonly kind: "defer"; readonly dueAt: Date; readonly reason?: string };

export type SweepHandler = (item: WorkItem) => Promise<SweepOutcome>;

export interface SweepDeps {
  readonly work: DurableWorkStore;
  readonly clock: Clock;
  /** One handler per work kind. A kind with no handler is left alone. */
  readonly handlers: Partial<Record<WorkKind, SweepHandler>>;
  /** How many items one pass takes. Bounded so a backlog cannot starve the loop. */
  readonly batchSize?: number;
}

export interface SweepReport {
  readonly examined: number;
  readonly completed: number;
  readonly failed: number;
  readonly deferred: number;
  /** Kinds encountered with no handler registered — a wiring mistake, visible. */
  readonly unhandled: readonly WorkKind[];
}

/**
 * One pass. Every test in this phase drives THIS, never the loop below: a pass
 * is deterministic, and a loop is a promise about wall-clock time that a test
 * would have to wait for.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.clock.now();
  const items = await deps.work.due(now, deps.batchSize);

  let completed = 0;
  let failed = 0;
  let deferred = 0;
  const unhandled = new Set<WorkKind>();

  for (const item of items) {
    const handler = deps.handlers[item.kind];

    if (handler === undefined) {
      unhandled.add(item.kind);
      continue;
    }

    // A handler that throws must not take the whole pass down with it: the
    // remaining items are other contacts' deliveries, and they are innocent.
    // `try` rather than `.catch()` on purpose — a handler whose body throws
    // BEFORE its first await never returns a promise to attach a catch to.
    let outcome: SweepOutcome;
    try {
      outcome = await handler(item);
    } catch (error: unknown) {
      outcome = {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // Re-read the clock: a handler that talked to the platform took real time,
    // and stamping the outcome with the instant the pass STARTED would record a
    // completion before the work that produced it.
    const at = deps.clock.now();

    switch (outcome.kind) {
      case "done":
        await deps.work.complete(item.id, at);
        completed += 1;
        break;
      case "failed":
        await deps.work.fail(item.id, outcome.reason, at);
        failed += 1;
        break;
      case "defer":
        await deps.work.defer(item.id, outcome.dueAt, at, outcome.reason);
        deferred += 1;
        break;
    }
  }

  return {
    examined: items.length,
    completed,
    failed,
    deferred,
    unhandled: [...unhandled],
  };
}

export interface SweepLoop {
  stop(): void;
}

/**
 * The running loop, for the process. Deliberately thin, and deliberately
 * untested by the fast suite: what it adds over `runSweep` is `setTimeout`, and
 * a test of `setTimeout` is a test of Node.
 *
 * Re-armed after each pass rather than on a fixed interval, so a slow pass
 * never overlaps the next one — overlapping passes would hand the same due item
 * to two handlers, which is precisely the duplicate REQ-016 forbids.
 */
export function startSweep(deps: SweepDeps, intervalMs: number): SweepLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    void runSweep(deps).finally(() => {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        // Nothing here should hold the process open on its own.
        timer.unref?.();
      }
    });
  };

  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}
