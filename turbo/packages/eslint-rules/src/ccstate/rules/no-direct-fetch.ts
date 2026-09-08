/**
 * ESLint rule: no-direct-fetch
 *
 * API calls use `apiClient$` and typed contracts. Public assets and presigned
 * transfers use the credential-free resource transport. Native fetch is only
 * permitted at that transport's definition site.
 *
 * Good:
 *   const client = get(apiClient$)(someContract);
 *   const result = await client.doSomething();
 *
 * Bad:
 *   await fetch("/api/chat/events", { method: "POST" });
 */

import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-direct-fetch",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require typed API clients or the resource transport instead of native fetch",
    },
    schema: [],
    messages: {
      noNativeFetch:
        "Use apiClient$ for API calls or fetchResource for public assets and presigned transfers. Do not use native fetch directly.",
    },
  },
  create(context) {
    return {
      Identifier(node: TSESTree.Identifier) {
        if (node.name === "fetch") {
          const scope = context.sourceCode.getScope(node);
          const reference = scope.references.find(
            (entry) => entry.identifier === node,
          );
          if (reference) {
            const variable = ASTUtils.findVariable(scope, node);
            if (!variable || variable.defs.length === 0) {
              context.report({ node, messageId: "noNativeFetch" });
            }
          }
        }
      },
      MemberExpression(node: TSESTree.MemberExpression) {
        if (
          node.object.type !== AST_NODE_TYPES.Identifier ||
          !["globalThis", "window", "self"].includes(node.object.name)
        ) {
          return;
        }
        const name = node.computed
          ? node.property.type === AST_NODE_TYPES.Literal && node.property.value
          : node.property.type === AST_NODE_TYPES.Identifier &&
            node.property.name;
        const variable = ASTUtils.findVariable(
          context.sourceCode.getScope(node),
          node.object,
        );
        if (name === "fetch" && (!variable || variable.defs.length === 0)) {
          context.report({ node, messageId: "noNativeFetch" });
        }
      },
    };
  },
});
