import { unifiedAutomationSchema } from "../flows/schema.js";
import type { UnifiedAutomation } from "../flows/schema.js";

/**
 * The stored text as the CURRENT schema reads it, or the reason it refuses.
 *
 * A verdict and never an exception, which is the whole reason this module
 * exists: a stored document the schema refuses is a normal state of a real
 * instance (phase 3l took `name` out of the format, REQ-284 took the
 * attachment out, both by decisions that stand), and a throw makes that one
 * row decide the fate of every question asked in the same breath as it.
 */
export type AutomationDocument =
  | { readonly ok: true; readonly definition: UnifiedAutomation }
  | { readonly ok: false; readonly reason: unknown };

/**
 * ONE parse for every reader of the aggregate table (REQ-294).
 *
 * It is shared and not copied because the two sides of this answer have to
 * agree by construction: the repository drops from its listing exactly the
 * rows the coverage reader reports as unreadable, so a row is counted once on
 * each side rather than once and then never again. Two copies of this parse is
 * where one side starts calling readable what the other side is reporting as
 * lost, and the row disappears with nothing said, which is the defect the
 * requirement exists against.
 */
export function readAutomationDocument(definition: string): AutomationDocument {
  let document: unknown;
  try {
    document = JSON.parse(definition);
  } catch (reason) {
    return { ok: false, reason };
  }

  const parsed = unifiedAutomationSchema.safeParse(document);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : { ok: false, reason: parsed.error };
}
