/**
 * The `mermaid-lite-real` alias (vitest.config.ts) resolves to the actual
 * lightweight distribution, bypassing the package's stub alias, the same
 * way `idb-real` does for idb.
 */
declare module "mermaid-lite-real" {
  const mermaid: (typeof import("@okouai/mermaid-lite"))["default"];
  export default mermaid;
}
