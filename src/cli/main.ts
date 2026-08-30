import { createOperatorCredentialStore } from "../auth/index.js";
import type { OperatorCredentialStore } from "../auth/index.js";
import { t } from "../i18n/index.js";
import { readOperationalStatus } from "../platform/status.js";
import type { OperationalStatus, StatusDeps } from "../platform/status.js";
import { createAuditRepository } from "../storage/audit.js";
import { createCredentialStore } from "../storage/credentials.js";
import { openDatabase } from "../storage/database.js";
import { createDurableWorkStore } from "../storage/durable-work.js";
import { runSetPassword } from "./set-password.js";
import { createTerminalSecretReader } from "./terminal-secret.js";

/**
 * The entry point (REQ-083). It reads arguments, prints and picks an exit code.
 *
 * Deliberately thin, and deliberately free of platform credentials: importing
 * and listing must work on a fresh installation where no token has been
 * configured yet.
 */

const USAGE = `mychat <command>

  status                           credential health, open alerts, queue depth
  set-password                     set or replace the operator password
`;

interface OpenedDatabase {
  readonly status: StatusDeps;
  readonly operator: OperatorCredentialStore;
  readonly close: () => void;
}

function openStores(databasePath: string): OpenedDatabase {
  const handle = openDatabase({ databasePath });
  return {
    status: {
      credentials: createCredentialStore(handle.db),
      audit: createAuditRepository(handle.db),
      work: createDurableWorkStore(handle.db),
    },
    operator: createOperatorCredentialStore(handle.db),
    close: () => {
      handle.close();
    },
  };
}

/**
 * Renders the operational status (REQ-081, REQ-088).
 *
 * The exit code is the point, not the text: a non-zero exit while an alert
 * stands is what lets a cron job, a health check or an operator's shell notice
 * that deliveries have stopped. Text alone would be one more thing nobody
 * reads.
 */
function reportStatus(
  status: OperationalStatus,
  out: (line: string) => void,
): number {
  if (!status.credentialConfigured) {
    // A fresh installation is not a fault, and must not look like one.
    out(t("status.credentialMissing"));
  } else {
    out(t("status.credentialPath", { path: status.authPath }));
    out(
      status.expiresAt === undefined
        ? t("status.credentialNeverExpires")
        : t("status.credentialExpires", {
            expiresAt: status.expiresAt.toISOString(),
          }),
    );
    out(
      status.lastCheckedAt === undefined
        ? t("status.neverChecked")
        : t("status.lastChecked", { at: status.lastCheckedAt.toISOString() }),
    );
    if (status.lastRefreshedAt !== undefined) {
      out(
        t("status.lastRefreshed", { at: status.lastRefreshedAt.toISOString() }),
      );
    }
  }

  out(t("status.pendingWork", { count: status.pendingWork }));

  if (status.openAlert === undefined) {
    out(t("status.healthy"));
    return 0;
  }

  out(
    t(
      status.openAlert.origin === "machine"
        ? "status.alertOpenMachine"
        : "status.alertOpen",
      {
        reason: status.openAlert.reason,
        at: status.openAlert.occurredAt.toISOString(),
      },
    ),
  );
  return 1;
}

export async function run(
  argv: readonly string[],
  databasePath: string,
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === "help" || command === "--help") {
    out(USAGE);
    return 0;
  }

  const { status, operator, close } = openStores(databasePath);

  try {
    switch (command) {
      case "status":
        // Works with no credential configured, like `list` (REQ-083): a fresh
        // installation must be able to ask what its own state is.
        return reportStatus(await readOperationalStatus(status), out);

      case "set-password": {
        const secrets = createTerminalSecretReader();
        try {
          return await runSetPassword({
            credentials: operator,
            secrets,
            now: () => new Date(),
            out,
            err,
          });
        } finally {
          // An open readline holds the event loop; without this the CLI hangs.
          secrets.close();
        }
      }

      default:
        err(USAGE);
        return 2;
    }
  } finally {
    close();
  }
}
