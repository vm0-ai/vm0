export const BRANDED_API_NAMESPACE_PATHS = ["/api/okou", "/api/zero"] as const;

export type BrandedApiNamespacePath =
  (typeof BRANDED_API_NAMESPACE_PATHS)[number];

export type BrandedApiNamespace =
  BrandedApiNamespacePath extends `/api/${infer Namespace}` ? Namespace : never;

function brandedPathSuffix(path: string): string | undefined {
  for (const namespacePath of BRANDED_API_NAMESPACE_PATHS) {
    if (path === namespacePath) {
      return "";
    }
    if (path.startsWith(`${namespacePath}/`)) {
      return path.slice(namespacePath.length);
    }
  }
  return undefined;
}

export function brandedApiNamespace(
  path: string,
): BrandedApiNamespace | undefined {
  if (path === "/api/zero" || path.startsWith("/api/zero/")) {
    return "zero";
  }
  if (path === "/api/okou" || path.startsWith("/api/okou/")) {
    return "okou";
  }
  return undefined;
}

/**
 * Returns both supported paths for a branded API route and the original path
 * for a neutral route. The result is independent of which branded namespace
 * the source contract currently uses.
 */
export function apiNamespaceAliasPaths(path: string): readonly string[] {
  const suffix = brandedPathSuffix(path);
  if (suffix === undefined) {
    return [path];
  }
  return BRANDED_API_NAMESPACE_PATHS.map((namespacePath) => {
    return `${namespacePath}${suffix}`;
  });
}
