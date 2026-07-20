const GRANT_COMPENSATION_TIMEOUT_MS = 5_000;

class ConnectorGrantCompensationError extends Error {
  readonly primaryError: unknown;
  readonly compensationError: unknown;

  constructor(primaryError: unknown, compensationError: unknown) {
    super("Connector grant cleanup failed after grant finalization failed", {
      cause: primaryError,
    });
    this.name = "ConnectorGrantCompensationError";
    this.primaryError = primaryError;
    this.compensationError = compensationError;
  }
}

export async function withConnectorGrantCompensation<T>(
  operation: () => Promise<T>,
  compensate: (signal: AbortSignal) => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (primaryError) {
    try {
      await compensate(AbortSignal.timeout(GRANT_COMPENSATION_TIMEOUT_MS));
    } catch (compensationError) {
      throw new ConnectorGrantCompensationError(
        primaryError,
        compensationError,
      );
    }
    throw primaryError;
  }
}

export function connectorGrantPrimaryError(error: unknown): unknown {
  return error instanceof ConnectorGrantCompensationError
    ? error.primaryError
    : error;
}

export function connectorGrantCleanupError(
  error: unknown,
): unknown | undefined {
  return error instanceof ConnectorGrantCompensationError
    ? error.compensationError
    : undefined;
}

export function requiredConnectorGrantOutput(
  outputs: Readonly<Record<string, string | null | undefined>>,
  name: string,
): string {
  const value = outputs[name];
  if (!value) {
    throw new Error(`Connector grant cleanup requires ${name}`);
  }
  return value;
}
