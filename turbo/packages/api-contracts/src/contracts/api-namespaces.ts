/**
 * The two brand namespaces a URL path can carry. Written out rather than
 * derived from a path list: #31094 removed the alias expansion that needed the
 * list, and the only thing left that reads a namespace is the reader below.
 */
export type BrandedApiNamespace = "okou" | "zero";

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
