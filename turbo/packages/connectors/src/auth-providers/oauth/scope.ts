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
  return reportedScopes === null || reportedScopes === undefined
    ? [...authorizationScopes]
    : reportedScopes.split(separator).filter(Boolean);
}
