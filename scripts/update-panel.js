import { createUpdatePlan } from "./update-plan.js";

const localAuthentication = (value) =>
  value?.kind === "local" && value.authenticated === true;

/**
 * Connects the authenticated panel to the exact same restricted update
 * operation used by the local terminal.  The panel never receives a shell or
 * Docker capability: it can only hand an already reauthenticated request to
 * that operation.
 */
export function createUpdatePanel({
  terminalOperation = createUpdatePlan,
  stateStore,
} = {}) {
  if (typeof terminalOperation !== "function") {
    throw new TypeError("terminalOperation must be a function");
  }
  if (typeof stateStore?.append !== "function") {
    throw new TypeError("stateStore.append must be a function");
  }

  return {
    async requestUpdate({ localAuth, currentRelease, targetRelease }) {
      // This check is deliberately here as well as in the terminal operation:
      // a panel session alone must never become authority to update.
      if (!localAuthentication(localAuth)) {
        throw new Error("panel update requires local reauthentication");
      }

      const request = {
        command: "update",
        currentRelease,
        localAuth,
        targetRelease,
      };
      await stateStore.append({ operation: "update", state: "running" });

      try {
        const result = await terminalOperation(request);
        const state = result?.state === "reverted" ? "reverted" : "completed";
        await stateStore.append({ operation: "update", result, state });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await stateStore.append({
          error: message,
          operation: "update",
          state: "failed",
        });
        throw error;
      }
    },
  };
}
