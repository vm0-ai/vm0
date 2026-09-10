/** The page owns recovery for a failed browser SharedWorker connection. */
export class SharedDatabaseWorkerLoadError extends Error {
  constructor(cause: unknown) {
    super("Shared database worker failed to load", { cause });
    this.name = "SharedDatabaseWorkerLoadError";
  }
}
