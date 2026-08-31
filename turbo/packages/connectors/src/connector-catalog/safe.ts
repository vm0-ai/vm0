function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  );
}

export function attempt<T>(
  operation: () => T,
): { readonly ok: T } | { readonly error: unknown } {
  try {
    return { ok: operation() };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { error };
  }
}

export function parseJson(input: string): unknown {
  const parsed = attempt((): unknown => {
    return JSON.parse(input);
  });
  return "ok" in parsed ? parsed.ok : undefined;
}
