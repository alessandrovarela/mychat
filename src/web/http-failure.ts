/** The status preserved by private HTTP clients when their session is gone. */
export const UNAUTHORIZED_FAILURE = "401";

/** Tell an expired private session apart from every other request failure. */
export function isUnauthorizedFailure(failure: unknown): boolean {
  return failure instanceof Error && failure.message === UNAUTHORIZED_FAILURE;
}
