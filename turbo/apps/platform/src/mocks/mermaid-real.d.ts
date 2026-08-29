/**
 * The `mermaid-real` alias (vitest.config.ts) resolves to the production
 * distribution, bypassing the package's stub alias, the same way `idb-real`
 * does for idb.
 */
declare module "mermaid-real" {
  const mermaid: (typeof import("mermaid"))["default"];
  export default mermaid;
}
