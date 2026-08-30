import type { PlatformLimits } from "../config/limits.js";
import { t } from "../i18n/index.js";

/**
 * The two delivery windows (REQ-019, REQ-080).
 *
 * They are TWO, and which one applies comes from the ORIGIN of the execution,
 * not from the contact. A run born from a comment answers under the
 * private-reply window of seven days, counted from the comment. A run born from
 * a direct message answers under the twenty-four hour window, counted from the
 * contact's last message. The same contact can be inside one and outside the
 * other at the same instant, so collapsing them into one number loses six days
 * on one path and invents six on the other.
 *
 * Outside the window nothing is sent and no request is even built: the platform
 * would refuse it, and spending a call to be refused is a call the private-reply
 * ceiling cannot afford.
 */

export type ExecutionOrigin = "comment" | "direct_message";

export const DELIVERY_WINDOWS = [
  "comment_reply_7d",
  "direct_message_24h",
] as const;

export type DeliveryWindow = (typeof DELIVERY_WINDOWS)[number];

export type WindowVerdict =
  | { readonly allowed: true; readonly window: DeliveryWindow }
  | {
      readonly allowed: false;
      readonly window: DeliveryWindow;
      readonly origin: ExecutionOrigin;
      /** Names the window AND the origin, which is what REQ-080 asks for. */
      readonly reason: string;
    };

export type WindowLimits = Pick<
  PlatformLimits,
  "messageWindowHours" | "commentReplyWindowDays"
>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Which window an origin answers under, and how long it lasts. */
export function windowFor(
  origin: ExecutionOrigin,
  limits: WindowLimits,
): { readonly window: DeliveryWindow; readonly durationMs: number } {
  return origin === "comment"
    ? {
        window: "comment_reply_7d",
        durationMs: limits.commentReplyWindowDays * DAY_MS,
      }
    : {
        window: "direct_message_24h",
        durationMs: limits.messageWindowHours * HOUR_MS,
      };
}

/**
 * Is a send still inside the window its origin answers under?
 *
 * `since` is the instant the window counts from: the comment for one origin,
 * the contact's last message for the other. It is captured when the event
 * arrives, which is the only moment either is known for certain.
 */
export function checkWindow(
  origin: ExecutionOrigin,
  since: Date,
  now: Date,
  limits: WindowLimits,
): WindowVerdict {
  const { window, durationMs } = windowFor(origin, limits);
  const elapsed = now.getTime() - since.getTime();

  if (elapsed <= durationMs) {
    return { allowed: true, window };
  }

  return {
    allowed: false,
    window,
    origin,
    reason: t("window.outsideWindow", {
      window,
      origin,
      since: since.toISOString(),
    }),
  };
}
