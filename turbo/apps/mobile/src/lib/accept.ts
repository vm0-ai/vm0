/**
 * Type-safe API response assertion helper.
 *
 * Accepts only the expected HTTP status codes. Throws on unexpected status
 * so that error-boundary and toast layers can surface the failure.
 */

interface AcceptOptions {
  toast?: boolean;
}

export async function accept<
  T extends { status: number; body: unknown },
  S extends number,
>(
  result: T | Promise<T>,
  expectedStatuses: readonly S[],
  options: AcceptOptions = {},
): Promise<{ status: S; body: Extract<T, { status: S }>["body"] }> {
  const resolved = await result;
  if (!expectedStatuses.includes(resolved.status as S)) {
    throw new Error(
      `Unexpected status ${String(resolved.status)}, expected one of ${expectedStatuses.join(", ")}`,
    );
  }
  return resolved as { status: S; body: Extract<T, { status: S }>["body"] };
}
