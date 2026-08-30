import { describe, expect, it } from "vitest";
import { createTriggerSwitchPreference } from "./trigger-switches.js";

const T0 = new Date("2026-08-06T10:00:00.000Z");
const T1 = new Date("2026-08-06T10:01:00.000Z");

function harness() {
  let stored: string | undefined;
  let now = T0;
  const preference = createTriggerSwitchPreference({
    store: {
      read: () => Promise.resolve(stored),
      write: (value) => {
        stored = value;
        return Promise.resolve();
      },
    },
    now: () => now,
  });
  return {
    preference,
    advance: () => {
      now = T1;
    },
    restart: () =>
      createTriggerSwitchPreference({
        store: {
          read: () => Promise.resolve(stored),
          write: (value) => {
            stored = value;
            return Promise.resolve();
          },
        },
        now: () => now,
      }),
  };
}

describe("REQ-204: persisted instance trigger switches", () => {
  it("defaults Tudo, Comentários and Mensagens diretas to on", async () => {
    const { preference } = harness();

    expect(await preference.read()).toEqual({
      all: { enabled: true },
      comments: { enabled: true },
      directMessages: { enabled: true },
    });
  });

  it("persists channel choices and their own change instants", async () => {
    const run = harness();
    await run.preference.choose("comments", false);
    run.advance();
    await run.preference.choose("directMessages", false);

    expect(await run.restart().read()).toEqual({
      all: { enabled: true },
      comments: { enabled: false, updatedAt: T0 },
      directMessages: { enabled: false, updatedAt: T1 },
    });
  });

  it("uses Tudo as an override without rewriting either channel", async () => {
    const { preference, advance } = harness();
    await preference.choose("comments", false);
    advance();
    await preference.choose("all", false);

    expect(await preference.allows("comment")).toBe(false);
    expect(await preference.allows("direct_message")).toBe(false);

    await preference.choose("all", true);
    expect(await preference.allows("comment")).toBe(false);
    expect(await preference.allows("direct_message")).toBe(true);
    expect((await preference.read()).comments.updatedAt).toEqual(T0);
  });
});
