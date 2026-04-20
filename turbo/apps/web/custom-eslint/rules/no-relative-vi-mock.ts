/**
 * ESLint rule: no-relative-vi-mock
 *
 * Prevents vi.mock() and vi.doMock() from using relative paths.
 * Tests should only mock external dependencies (third-party packages,
 * built-in Node.js modules), not internal project code.
 *
 * Good:
 *   vi.mock("@clerk/nextjs/server", () => ({...}));
 *   vi.mock("next/server", () => ({...}));
 *   vi.mock("ably", () => ({...}));
 *
 * Bad:
 *   vi.mock("../lib/utils", () => ({...}));
 *   vi.mock("./helpers", () => ({...}));
 *   vi.doMock("../../services/auth", () => ({...}));
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-relative-vi-mock",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow relative paths in vi.mock(). Only external dependencies should be mocked.",
      recommended: true,
    },
    schema: [],
    messages: {
      noRelativeMock:
        "Do not use relative paths in vi.mock(). Only mock external dependencies (third-party packages, built-in modules). See CLAUDE.md testing guidelines.",
    },
  },
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          node.callee.object.type !== AST_NODE_TYPES.Identifier ||
          node.callee.object.name !== "vi" ||
          node.callee.property.type !== AST_NODE_TYPES.Identifier ||
          (node.callee.property.name !== "mock" &&
            node.callee.property.name !== "doMock")
        ) {
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg) {
          return;
        }

        let mockPath: string | undefined;

        if (
          firstArg.type === AST_NODE_TYPES.Literal &&
          typeof firstArg.value === "string"
        ) {
          mockPath = firstArg.value;
        } else if (firstArg.type === AST_NODE_TYPES.TemplateLiteral) {
          if (
            firstArg.quasis.length === 1 &&
            firstArg.expressions.length === 0
          ) {
            mockPath = firstArg.quasis[0]?.value.cooked ?? undefined;
          }
        }

        if (
          mockPath &&
          (mockPath.startsWith("./") || mockPath.startsWith("../"))
        ) {
          context.report({
            node: firstArg,
            messageId: "noRelativeMock",
          });
        }
      },
    };
  },
});
