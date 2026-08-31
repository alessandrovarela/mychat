export type FirstUseStatus = {
  automation: "saved-draft";
  meta: "not-configured" | "configured";
  status: "local-draft" | "awaiting-external-verification";
  next: {
    phase: "4e";
    status: "deferred-external-verification";
    requires: readonly [
      "Meta configuration",
      "a separate test account",
      "received event evidence",
      "execution evidence",
      "result evidence",
    ];
  };
};

export function createFirstUseStatus(options?: {
  metaConfigured?: boolean;
}): FirstUseStatus;

export function firstUseGuide(): {
  local: {
    action: string;
    expectedStatus: FirstUseStatus;
    doesNotProve: string[];
  };
  real: {
    action: string;
    expectedStatus: FirstUseStatus;
    deferredToPhase: "4e";
  };
};
