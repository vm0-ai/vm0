import { command } from "ccstate";

import { logger } from "../../lib/log";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { tapError } from "../utils";

const L = logger("StoragePrefixPurge");

interface StoragePrefixPurgeArgs {
  readonly bucket: string;
  readonly s3Prefix: string;
}

const listAndDeletePrefixObjects$ = command(
  async (
    { get },
    args: StoragePrefixPurgeArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const objects = await get(
      listS3ObjectsUnderPrefix(args.bucket, args.s3Prefix),
    );
    signal.throwIfAborted();
    await get(
      deleteS3Objects(
        args.bucket,
        objects.map((object) => {
          return object.key;
        }),
      ),
    );
    signal.throwIfAborted();
  },
);

/**
 * Release the objects under a storage prefix whose owning `storages` row was
 * already deleted by a committed transaction.
 *
 * That commit is durable and it removed the only pointer to the prefix, so a
 * caller retry can never reach this cleanup again. Reporting an upstream
 * object-store failure as a failed deletion would therefore turn a committed
 * success into a misleading 5xx while leaving the objects orphaned either way.
 * Log the orphaned prefix instead so it stays auditable and recoverable. Abort
 * still propagates.
 */
export const purgeDeletedStoragePrefix$ = command(
  async (
    { set },
    args: StoragePrefixPurgeArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    await tapError(set(listAndDeletePrefixObjects$, args, signal), (error) => {
      L.warn("Failed to release objects under a deleted storage prefix", {
        bucket: args.bucket,
        s3Prefix: args.s3Prefix,
        error,
      });
    });
    signal.throwIfAborted();
  },
);
