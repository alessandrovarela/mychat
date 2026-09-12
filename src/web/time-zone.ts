/**
 * A time zone is persisted as its IANA identifier, while the picker adds the
 * offset that is in force now. Keeping those jobs separate means daylight
 * saving changes the label when it should, without changing the value sent to
 * the server.
 */
export function utcOffsetOf(timeZone: string, at = new Date()): string {
  try {
    const offset = new Intl.DateTimeFormat("en", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (offset === undefined) return "UTC";
    return offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC");
  } catch {
    // The server has already vetted this identifier. If a browser cannot
    // format it, showing the identifier is still clearer than a made-up offset.
    return "UTC";
  }
}

export function timeZoneOptionLabel(timeZone: string, at = new Date()): string {
  return `${timeZone} (${utcOffsetOf(timeZone, at)})`;
}
