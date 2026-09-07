export class SharedDatabaseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Shared database request failed with status ${status}`);
    this.name = "SharedDatabaseHttpError";
  }
}
