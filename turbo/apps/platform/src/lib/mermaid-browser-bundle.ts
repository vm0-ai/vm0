import type mermaidApi from "mermaid";
import "mermaid/dist/mermaid.min.js";

const mermaid = (
  globalThis as typeof globalThis & { readonly mermaid: typeof mermaidApi }
).mermaid;

export default mermaid;
