/**
 * ESLint rule: setup-page-render
 *
 * Enforces correct usage of setupPage's withoutRender option:
 * - In src/signals/ tests: setupPage must use withoutRender: true
 * - In src/views/ tests: setupPage must NOT use withoutRender
 *
 * Signal tests should never render React components. View tests must
 * render to test the actual UI.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "setup-page-render",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce withoutRender in signal tests and forbid it in view tests",
    },
    schema: [],
    messages: {
      missingWithoutRender:
        "setupPage in src/signals/ tests must use withoutRender: true. Signal tests should not render React components.",
      forbiddenWithoutRender:
        "setupPage in src/views/ tests must not use withoutRender. View tests need React rendering to test the UI.",
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, "/");
    const isSignalTest = /\/src\/signals\/.*__tests__/.test(filename);
    const isViewTest = /\/src\/views\/.*__tests__/.test(filename);

    if (!isSignalTest && !isViewTest) {
      return {};
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          node.callee.name !== "setupPage"
        ) {
          return;
        }

        const firstArg = node.arguments[0];
        if (!firstArg || firstArg.type !== AST_NODE_TYPES.ObjectExpression) {
          return;
        }

        const withoutRenderProp = firstArg.properties.find(
          (prop): prop is TSESTree.Property =>
            prop.type === AST_NODE_TYPES.Property &&
            prop.key.type === AST_NODE_TYPES.Identifier &&
            prop.key.name === "withoutRender",
        );

        if (isSignalTest && !withoutRenderProp) {
          context.report({
            node,
            messageId: "missingWithoutRender",
          });
        }

        if (isViewTest && withoutRenderProp) {
          context.report({
            node: withoutRenderProp,
            messageId: "forbiddenWithoutRender",
          });
        }
      },
    };
  },
});
