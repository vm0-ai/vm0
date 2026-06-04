export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

export function isProviderHttpError(
  value: unknown,
): value is ProviderHttpError {
  return value instanceof ProviderHttpError;
}
