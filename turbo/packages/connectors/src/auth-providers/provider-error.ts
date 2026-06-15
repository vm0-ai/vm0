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

export class ProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

export function isProviderResponseError(
  value: unknown,
): value is ProviderResponseError {
  return value instanceof ProviderResponseError;
}
