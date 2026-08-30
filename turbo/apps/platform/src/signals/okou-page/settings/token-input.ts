const TOKEN_WHITESPACE_RE = /\s+/g;

export function sanitizeTokenInput(value: string): string {
  return value.replace(TOKEN_WHITESPACE_RE, "");
}

export function hasTokenInputValue(value: string | undefined): boolean {
  return value !== undefined && sanitizeTokenInput(value).length > 0;
}

export function sanitizeTokenInputRecord(
  values: Record<string, string>,
  options?: { readonly preserveWhitespaceKeys?: ReadonlySet<string> },
): Record<string, string> {
  const preserveWhitespaceKeys: ReadonlySet<string> =
    options?.preserveWhitespaceKeys ?? new Set<string>();

  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      return [
        key,
        preserveWhitespaceKeys.has(key)
          ? value.trim()
          : sanitizeTokenInput(value),
      ];
    }),
  );
}
