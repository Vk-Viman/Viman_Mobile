/**
 * services/external-backup-hooks.ts - test seams for the external backup copy.
 *
 * Layer: service support. In production every hook is undefined and the real file system and clock are used.
 * Tests set a hook to simulate what real drives do and cannot be created on demand: a full drive
 * (`writeTemp` throws ENOSPC), a read-only drive (EROFS), a damaged copy (`afterWrite` changes the file),
 * a drive pulled out mid-copy (`beforeRename` removes the folder) and a different clock (`now`).
 * Always call `resetExternalHooks()` after a test that sets one.
 */

export interface ExternalHooks {
  /** Replaces writing a new file into the external folder (also used by the folder write probe). */
  writeTemp?: (path: string, data: Buffer) => Promise<void>;
  /** Runs after the temporary copy was written and before it is verified (a test may corrupt the file here). */
  afterWrite?: (tmpPath: string) => Promise<void> | void;
  /** Runs after verification and before the rename to the final name. */
  beforeRename?: (tmpPath: string, finalPath: string) => Promise<void> | void;
  /** The clock used for statuses and log times. */
  now?: () => Date;
  /** When true, setting a folder does not start the immediate synchronization (lets a test set up a drive that is still empty). */
  noSyncOnSet?: boolean;
}

/** The active hooks (mutated by tests). */
export const externalHooks: ExternalHooks = {};

/** Removes every hook. */
export function resetExternalHooks(): void {
  delete externalHooks.writeTemp;
  delete externalHooks.afterWrite;
  delete externalHooks.beforeRename;
  delete externalHooks.now;
  delete externalHooks.noSyncOnSet;
}

/** The current time according to the hooks (real time in production). */
export function externalNow(): Date {
  return externalHooks.now ? externalHooks.now() : new Date();
}
