/**
 * ESLint rule: no-direct-fetch
 *
 * Disallows direct usage of `fetch$`. All API calls should use `zeroClient$`
 * which provides type-safe request/response handling via ts-rest contracts.
 *
 * Good:
 *   const client = get(zeroClient$)(someContract);
 *   const result = await client.doSomething();
 *
 * Bad:
 *   const fetchFn = get(fetch$);
 *   await fetchFn("/api/zero/something", { method: "POST" });
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-direct-fetch",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct usage of fetch$ — use zeroClient$ for type-safe API calls instead",
    },
    schema: [],
    messages: {
      noDirectFetch:
        "Do not use fetch$ directly. Use zeroClient$ from signals/api-client.ts for type-safe API calls instead.",
    },
  },
  create(context) {
    return {
      Identifier(node: TSESTree.Identifier) {
        if (node.name !== "fetch$") {
          return;
        }

        // Allow the definition of fetch$ itself (e.g. `export const fetch$ = ...`)
        if (
          node.parent.type === AST_NODE_TYPES.VariableDeclarator &&
          node.parent.id === node
        ) {
          return;
        }

        // Allow import specifiers (e.g. `import { fetch$ } from ...`)
        if (node.parent.type === AST_NODE_TYPES.ImportSpecifier) {
          return;
        }

        context.report({
          node,
          messageId: "noDirectFetch",
        });
      },
    };
  },
});
