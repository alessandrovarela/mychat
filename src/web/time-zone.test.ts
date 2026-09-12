import { describe, expect, it } from "vitest";
import { timeZoneOptionLabel, utcOffsetOf } from "./time-zone.js";

describe("time-zone labels", () => {
  it("adds the offset in force while retaining the IANA identifier", () => {
    const instant = new Date("2026-01-15T12:00:00.000Z");
    expect(utcOffsetOf("UTC", instant)).toBe("UTC+00:00");
    expect(timeZoneOptionLabel("America/Toronto", instant)).toBe(
      "America/Toronto (UTC-05:00)",
    );
  });
});
