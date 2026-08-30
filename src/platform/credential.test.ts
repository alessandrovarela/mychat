import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../cli/main.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuditRepository,
  createCredentialStore,
  createDurableWorkStore,
  IN_MEMORY_DATABASE,
  openDatabase,
} from "../storage/index.js";
import type {
  AuditRepository,
  CredentialStore,
  DatabaseHandle,
  DurableWorkStore,
} from "../storage/index.js";
import { runCredentialCheck } from "./credential-check.js";
import {
  createInstagramLoginAccount,
  INSTAGRAM_LOGIN_HOST,
} from "./instagram-login.js";
import { readOperationalStatus } from "./status.js";
import type { PlatformRequest, PlatformResponse } from "./transport.js";

/**
 * Proves REQ-081 and REQ-088.
 *
 * They are NOT the same requirement, and the tests keep them apart. REQ-081 is
 * about a token that expires and must be renewed before it does. REQ-088 is
 * about a credential that stopped working for ANY reason — revoked, permission
 * withdrawn — and holds even where nothing ever expires. A single test of
 * "credential is fine" would pass while the second one silently failed, which
 * is the exact failure mode the requirement was written against.
 */

const NOW = new Date("2026-08-01T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const THRESHOLD = 10 * DAY;

/** Captures what would have been sent, and answers what the test dictates. */
function recordingTransport(
  answers:
    PlatformResponse[] | ((request: PlatformRequest) => PlatformResponse),
) {
  const sent: PlatformRequest[] = [];
  const queue = Array.isArray(answers) ? [...answers] : undefined;

  return {
    sent,
    transport: (request: PlatformRequest): Promise<PlatformResponse> => {
      sent.push(request);
      if (queue !== undefined) {
        return Promise.resolve(
          queue.shift() ?? { status: 200, body: { id: "acct-1" } },
        );
      }
      return Promise.resolve(
        (answers as (r: PlatformRequest) => PlatformResponse)(request),
      );
    },
  };
}

describe("REQ-081: the token renews itself before it dies", () => {
  let handle: DatabaseHandle;
  let credentials: CredentialStore;
  let audit: AuditRepository;

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    credentials = createCredentialStore(handle.db);
    audit = createAuditRepository(handle.db);
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-old",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 60 * DAY),
      },
      NOW,
    );
  });

  afterEach(() => {
    handle.close();
  });

  it("leaves a token alone while expiry is far away", async () => {
    const { sent, transport } = recordingTransport([]);
    const account = createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: THRESHOLD,
    });

    expect(await account.refreshIfNeeded(NOW)).toEqual({ kind: "not_needed" });
    expect(sent).toHaveLength(0);
  });

  it("renews once expiry is inside the threshold, and stores the new expiry", async () => {
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-old",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 5 * DAY),
      },
      NOW,
    );
    const { sent, transport } = recordingTransport([
      {
        status: 200,
        body: { access_token: "token-new", expires_in: 60 * 24 * 60 * 60 },
      },
    ]);
    const account = createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: THRESHOLD,
    });

    const outcome = await account.refreshIfNeeded(NOW);

    expect(outcome).toEqual({
      kind: "renewed",
      expiresAt: new Date(NOW.getTime() + 60 * DAY),
    });
    expect(sent[0]).toMatchObject({
      host: INSTAGRAM_LOGIN_HOST,
      path: "/refresh_access_token",
      query: { grant_type: "ig_refresh_token", access_token: "token-old" },
    });

    const stored = await credentials.read();
    expect(stored?.accessToken).toBe("token-new");
    expect(stored?.expiresAt).toEqual(new Date(NOW.getTime() + 60 * DAY));
    expect(stored?.lastRefreshedAt).toEqual(NOW);
  });

  it("records every renewal with its new expiry", async () => {
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-old",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 5 * DAY),
      },
      NOW,
    );
    const { transport } = recordingTransport([
      {
        status: 200,
        body: { access_token: "token-new", expires_in: 60 * 24 * 60 * 60 },
      },
      { status: 200, body: { id: "acct-1" } },
    ]);

    const outcome = await runCredentialCheck(
      {
        account: createInstagramLoginAccount({
          credentials,
          transport,
          refreshThresholdMs: THRESHOLD,
        }),
        audit,
      },
      NOW,
    );

    expect(outcome.kind).toBe("renewed");
    const entries = await audit.query({ kind: "alert" });
    expect(entries).toHaveLength(1);
    // The requirement asks for the NEW expiry to be on the record: without it
    // an operator cannot tell renewal from a no-op that logs cheerfully.
    expect(entries[0]?.reason).toContain(
      new Date(NOW.getTime() + 60 * DAY).toISOString(),
    );
    expect(entries[0]?.outcome).toBe("ok");
  });

  it("alerts when the renewal fails, and keeps the old token", async () => {
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-old",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 5 * DAY),
      },
      NOW,
    );
    const { transport } = recordingTransport([
      { status: 400, body: { error: { message: "cannot refresh" } } },
    ]);

    const outcome = await runCredentialCheck(
      {
        account: createInstagramLoginAccount({
          credentials,
          transport,
          refreshThresholdMs: THRESHOLD,
        }),
        audit,
      },
      NOW,
    );

    expect(outcome.kind).toBe("alert");
    expect((await audit.query({ kind: "alert" }))[0]?.outcome).toBe("failed");
    // A failed renewal must not destroy a token that still works: there are
    // many further chances inside the threshold.
    expect((await credentials.read())?.accessToken).toBe("token-old");
  });

  it("refuses a 200 whose body it cannot read", async () => {
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-old",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 5 * DAY),
      },
      NOW,
    );
    const { transport } = recordingTransport([
      { status: 200, body: { unexpected: true } },
    ]);
    const account = createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: THRESHOLD,
    });

    // Storing a partial credential would swap a working token for a broken one.
    expect((await account.refreshIfNeeded(NOW)).kind).toBe("failed");
    expect((await credentials.read())?.accessToken).toBe("token-old");
  });
});

describe("REQ-088: a credential that stopped working is announced", () => {
  let handle: DatabaseHandle;
  let credentials: CredentialStore;
  let audit: AuditRepository;

  beforeEach(async () => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    credentials = createCredentialStore(handle.db);
    audit = createAuditRepository(handle.db);
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-1",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() + 60 * DAY),
      },
      NOW,
    );
  });

  afterEach(() => {
    handle.close();
  });

  function accountWith(response: PlatformResponse) {
    const { transport } = recordingTransport(() => response);
    return createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: THRESHOLD,
    });
  }

  it("reports a working credential as healthy", async () => {
    const health = await accountWith({
      status: 200,
      body: { id: "acct-1" },
    }).check(NOW);

    expect(health.ok).toBe(true);
  });

  it("names revocation, not merely failure", async () => {
    const health = await accountWith({
      status: 401,
      body: { error: { message: "Invalid OAuth access token" } },
    }).check(NOW);

    expect(health).toEqual({ ok: false, reason: "revoked" });
  });

  it("names a withdrawn permission separately from revocation", async () => {
    // The two arrive with the same status and need different fixes, so the
    // reason has to separate them or the operator is left guessing.
    const health = await accountWith({
      status: 403,
      body: { error: { message: "Missing permission for this endpoint" } },
    }).check(NOW);

    expect(health).toEqual({ ok: false, reason: "permission_removed" });
  });

  it("names expiry without spending a call to be told so", async () => {
    await credentials.write(
      {
        authPath: "instagram_login",
        accessToken: "token-1",
        accountId: "acct-1",
        expiresAt: new Date(NOW.getTime() - 1000),
      },
      NOW,
    );
    const { sent, transport } = recordingTransport([]);
    const account = createInstagramLoginAccount({
      credentials,
      transport,
      refreshThresholdMs: THRESHOLD,
    });

    expect(await account.check(NOW)).toEqual({ ok: false, reason: "expired" });
    expect(sent).toHaveLength(0);
  });

  it("treats an unreachable platform as a failed check, never as fine", async () => {
    const account = createInstagramLoginAccount({
      credentials,
      transport: () => Promise.reject(new Error("network down")),
      refreshThresholdMs: THRESHOLD,
    });

    const outcome = await runCredentialCheck({ account, audit }, NOW);

    expect(outcome.kind).toBe("alert");
  });

  it("raises an alert naming the reason, without the token having expired", async () => {
    const outcome = await runCredentialCheck(
      {
        account: accountWith({
          status: 403,
          body: { error: { message: "Missing permission" } },
        }),
        audit,
      },
      NOW,
    );

    expect(outcome.kind).toBe("alert");
    const entries = await audit.query({ kind: "alert" });
    expect(entries[0]?.reason).toContain("permission_removed");
  });
});

describe("the operator can see it: status and its exit code", () => {
  let handle: DatabaseHandle;
  let credentials: CredentialStore;
  let audit: AuditRepository;
  let work: DurableWorkStore;

  beforeEach(() => {
    handle = openDatabase({ databasePath: IN_MEMORY_DATABASE });
    credentials = createCredentialStore(handle.db);
    audit = createAuditRepository(handle.db);
    work = createDurableWorkStore(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  it("reports a fresh installation as unconfigured, not as broken", async () => {
    const status = await readOperationalStatus({ credentials, audit, work });

    expect(status.credentialConfigured).toBe(false);
    expect(status.openAlert).toBeUndefined();
  });

  it("holds an alert open while it is the newest word on the subject", async () => {
    await audit.record(
      { kind: "alert", outcome: "failed", reason: "credential revoked" },
      NOW,
    );

    const status = await readOperationalStatus({ credentials, audit, work });

    expect(status.openAlert).toMatchObject({
      origin: "instance",
      reason: "credential revoked",
      occurredAt: NOW,
    });
  });

  it("closes an alert when a later check succeeds", async () => {
    await audit.record(
      { kind: "alert", outcome: "failed", reason: "credential revoked" },
      NOW,
    );
    await audit.record(
      { kind: "alert", outcome: "ok", reason: "renewed" },
      new Date(NOW.getTime() + 1000),
    );

    // Recency decides, so there is no status column to drift out of step with
    // what actually happened.
    expect(
      (await readOperationalStatus({ credentials, audit, work })).openAlert,
    ).toBeUndefined();
  });

  it("identifies an automatic pause with the same reason and instant the trail recorded", async () => {
    await audit.record(
      {
        kind: "alert",
        subtype: "automation_auto_paused",
        outcome: "failed",
        automationId: "launch-post",
        reason: "Launch post was paused automatically",
      },
      NOW,
    );

    const status = await readOperationalStatus({ credentials, audit, work });

    expect(status.openAlert).toEqual({
      origin: "machine",
      subtype: "automation_auto_paused",
      automationId: "launch-post",
      reason: "Launch post was paused automatically",
      occurredAt: NOW,
    });
  });

  it("counts the pending queue for the operator", async () => {
    await work.enqueue({ kind: "send", dedupeKey: "a", payload: {} }, NOW);

    expect(
      (await readOperationalStatus({ credentials, audit, work })).pendingWork,
    ).toBe(1);
  });
});

describe("REQ-083: status works with no credential, and exits meaningfully", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mychat-status-"));
    databasePath = join(directory, "mychat.db");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("succeeds on a fresh installation with nothing configured", async () => {
    const lines: string[] = [];

    const code = await run(["status"], databasePath, (line) =>
      lines.push(line),
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("not configured");
  });

  it("exits non-zero while an alert stands", async () => {
    const handle = openDatabase({ databasePath });
    await createAuditRepository(handle.db).record(
      { kind: "alert", outcome: "failed", reason: "credential revoked" },
      NOW,
    );
    handle.close();

    const lines: string[] = [];
    const code = await run(["status"], databasePath, (line) =>
      lines.push(line),
    );

    // The exit code is the point: a health check or a cron job notices this,
    // and text alone would be one more thing nobody reads.
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("credential revoked");
    expect(lines.join("\n")).toContain(NOW.toISOString());
  });

  it("names a machine pause as a system alert with its stored instant", async () => {
    const handle = openDatabase({ databasePath });
    await createAuditRepository(handle.db).record(
      {
        kind: "alert",
        subtype: "automation_auto_paused",
        outcome: "failed",
        automationId: "launch",
        reason: "Launch was paused automatically",
      },
      NOW,
    );
    handle.close();

    const lines: string[] = [];
    const code = await run(["status"], databasePath, (line) =>
      lines.push(line),
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("SYSTEM ALERT");
    expect(lines.join("\n")).toContain("Launch was paused automatically");
    expect(lines.join("\n")).toContain(NOW.toISOString());
  });
});
