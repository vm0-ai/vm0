export function authorizationScopesFromUrl(
  authorizationUrl: string,
): readonly string[] | undefined {
  const searchParams = new URL(authorizationUrl).searchParams;
  const serializedScopes =
    searchParams.get("scope") ?? searchParams.get("user_scope");
  return serializedScopes === null
    ? undefined
    : serializedScopes.split(/[ ,]+/).filter(Boolean);
}

export function effectiveOAuthScopes(
  reportedScopes: string | null | undefined,
  authorizationScopes: readonly string[],
  separator: string | RegExp,
): string[] {
  return (
    reportedOAuthScopes(reportedScopes, separator) ?? [...authorizationScopes]
  );
}

export function reportedOAuthScopes(
  reportedScopes: string | null | undefined,
  separator: string | RegExp,
): string[] | null {
  return reportedScopes === null || reportedScopes === undefined
    ? null
    : reportedScopes.split(separator).filter(Boolean);
}
