/**
 * The account port (ADR-022).
 *
 * There are TWO ways to authenticate against this platform, and they differ in
 * three things, not one: the API host (`graph.instagram.com` against
 * `graph.facebook.com`), the comment permission
 * (`instagram_business_manage_comments` against `instagram_manage_comments`)
 * and the token model. Treating them as "two ways to get a token" breaks at the
 * first endpoint called, which is why the port carries the host and the
 * permissions and not merely a string.
 *
 * `check()` and `refreshIfNeeded()` are separate on purpose. A token that never
 * expires is not a token that never fails: it can be revoked, its user removed
 * from the portfolio, its permission withdrawn. A design where health is a
 * side effect of renewal would leave the non-expiring path failing in silence,
 * which is exactly what REQ-088 exists to prevent.
 */

export const AUTH_PATHS = ["instagram_login", "system_user"] as const;

export type AuthPath = (typeof AUTH_PATHS)[number];

/** Everything a caller needs to build a request. Nothing more. */
export interface AccountCredential {
  readonly path: AuthPath;
  /** Differs per path. A caller must never hard-code this (REQ-090). */
  readonly host: string;
  readonly accessToken: string;
  /** The account's own platform id, the `<ig-id>` of `/<ig-id>/messages`. */
  readonly accountId: string;
  /** Absent on a path whose token does not expire. */
  readonly expiresAt?: Date;
}

/**
 * Why a credential stopped working. Every one of these is silent from the
 * inside: the process keeps running and the deliveries simply stop.
 */
export const CREDENTIAL_FAILURES = [
  "expired",
  "revoked",
  "permission_removed",
  "unreachable",
] as const;

export type CredentialFailure = (typeof CREDENTIAL_FAILURES)[number];

export type CredentialHealth =
  | { readonly ok: true; readonly expiresAt?: Date }
  | { readonly ok: false; readonly reason: CredentialFailure };

export type RefreshOutcome =
  /** Still far from expiry. Nothing to do, and nothing wrong. */
  | { readonly kind: "not_needed" }
  /** This path's token does not expire: renewal is inert, not a failure. */
  | { readonly kind: "not_applicable" }
  | { readonly kind: "renewed"; readonly expiresAt: Date }
  | { readonly kind: "failed"; readonly reason: string };

export interface PlatformAccount {
  /** The credential in force, for whoever is about to build a request. */
  current(): Promise<AccountCredential>;
  /** Does it still work? Asked of every path, including the eternal ones. */
  check(now: Date): Promise<CredentialHealth>;
  /** Renews when expiry is inside the threshold. Inert where nothing expires. */
  refreshIfNeeded(now: Date): Promise<RefreshOutcome>;
}
