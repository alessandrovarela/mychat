/**
 * Failures the persistence layer reports. Both carry enough identity for an
 * operator to act: which migration, or which record.
 */

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

/**
 * A migration could not be applied. The process must not go on to serve
 * requests after this: an incoherent schema is worse than a refusal to start
 * (acceptance criterion 20).
 */
export class MigrationError extends StorageError {
  /** Tag of the migration that failed, such as `0000_initial`. */
  readonly tag: string;

  constructor(tag: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.tag = tag;
  }
}
