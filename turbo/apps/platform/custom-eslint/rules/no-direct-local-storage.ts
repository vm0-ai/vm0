/**
 * ESLint rule: no-direct-local-storage
 *
 * Disallows direct access to `localStorage`. All localStorage access should go
 * through the `localStorageSignals()` abstraction in signals/external/local-storage.ts
 * which provides ccstate reactivity and test cleanup.
 *
 * Good:
 *   import { localStorageSignals } from "../external/local-storage";
 *   const { get$, set$, clear$ } = localStorageSignals("myKey");
 *
 * Bad:
 *   localStorage.getItem("myKey");
 *   localStorage.setItem("myKey", value);
 *   localStorage.removeItem("myKey");
 *   window.localStorage.getItem("myKey");
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isLocalStorage(node: TSESTree.Node): boolean {
  // bare `localStorage`
  if (node.type === AST_NODE_TYPES.Identifier && node.name === "localStorage") {
    return true;
  }
  // `window.localStorage`
  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    node.object.type === AST_NODE_TYPES.Identifier &&
    node.object.name === "window" &&
    node.property.type === AST_NODE_TYPES.Identifier &&
    node.property.name === "localStorage"
  ) {
    return true;
  }
  return false;
}

export default createRule({
  name: "no-direct-local-storage",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct localStorage access — use localStorageSignals() instead",
    },
    schema: [],
    messages: {
      noDirectLocalStorage:
        "Do not access localStorage directly. Use localStorageSignals() from signals/external/local-storage.ts instead.",
    },
  },
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        if (isLocalStorage(node.object)) {
          context.report({
            node,
            messageId: "noDirectLocalStorage",
          });
        }
      },
    };
  },
});
