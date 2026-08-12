/**
 * ESLint rule: no-test-after-each
 *
 * Platform tests must bind cleanup to the resource lifecycle instead of a
 * file-level afterEach hook. This keeps each test independent of hook order.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-test-after-each",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow file-level afterEach cleanup in platform tests",
    },
    schema: [],
    messages: {
      noTestAfterEach:
        "Do not use afterEach() in platform test files. Bind resources to testContext.signal, use testContext.track() for long-running promises, and rely on Vitest restoration for stubs and spies.",
    },
  },
  create(context) {
    const afterEachNames = new Set(["afterEach"]);

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.source.value !== "vitest") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.imported.type === AST_NODE_TYPES.Identifier &&
            specifier.imported.name === "afterEach"
          ) {
            afterEachNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          afterEachNames.has(node.callee.name)
        ) {
          context.report({ node, messageId: "noTestAfterEach" });
        }
      },
    };
  },
});
