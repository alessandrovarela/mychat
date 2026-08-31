/**
 * Describes the boundary between a safe local first-use exercise and a real
 * platform verification.  It deliberately records evidence, rather than
 * inferring a successful Meta delivery from local state.
 */
const localDraft = Object.freeze({
  automation: "saved-draft",
  meta: "not-configured",
  status: "local-draft",
});

const externalVerification = Object.freeze({
  phase: "4e",
  status: "deferred-external-verification",
  requires: Object.freeze([
    "Meta configuration",
    "a separate test account",
    "received event evidence",
    "execution evidence",
    "result evidence",
  ]),
});

/**
 * Returns a deterministic status for the initial journey.  Local persistence
 * is useful evidence that an automation can be drafted, but is never evidence
 * that Meta has delivered an event or that an account received a result.
 */
export function createFirstUseStatus({ metaConfigured = false } = {}) {
  if (typeof metaConfigured !== "boolean") {
    throw new TypeError("metaConfigured must be a boolean");
  }

  if (!metaConfigured) {
    return {
      ...localDraft,
      next: externalVerification,
    };
  }

  return {
    automation: "saved-draft",
    meta: "configured",
    status: "awaiting-external-verification",
    next: externalVerification,
  };
}

export function firstUseGuide() {
  return {
    local: {
      action: "save an automation as a draft",
      expectedStatus: createFirstUseStatus(),
      doesNotProve: [
        "Meta received an event",
        "the automation executed from a Meta event",
        "a second account received the result",
      ],
    },
    real: {
      action: "run the verification with a separate test account",
      expectedStatus: createFirstUseStatus({ metaConfigured: true }),
      deferredToPhase: "4e",
    },
  };
}
