/**
 * The `mermaid-flowchart-real` alias (vitest.config.ts) resolves to the actual
 * flowchart-only distribution, bypassing the package's stub alias, the same
 * way `idb-real` does for idb.
 */
declare module "mermaid-flowchart-real" {
  const mermaid: (typeof import("@okouai/mermaid-flowchart"))["default"];
  export default mermaid;
}
