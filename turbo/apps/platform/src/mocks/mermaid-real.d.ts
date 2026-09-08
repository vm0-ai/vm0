/**
 * The `mermaid-lite-real` alias (vitest.config.ts) resolves to the actual
 * lightweight distribution while the package entry point remains stubbed.
 */
declare module "mermaid-lite-real" {
  const mermaid: (typeof import("@okouai/mermaid-lite"))["default"];
  export default mermaid;
}
