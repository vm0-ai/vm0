/**
 * ESLint rule: no-user-clear-tab
 *
 * Disallows `user.clear()` and `user.tab()` in test files. These methods
 * simulate character-by-character keyboard events and add significant overhead
 * (~10–15ms per character for type, plus extra events for clear/tab).
 *
 * Use `user.fill(element, value)` instead, which sets the full value in one
 * operation while still firing the correct user-event semantics.
 *
 * Bad:
 *   await user.clear(input);
 *   await user.type(input, "hello");
 *   await user.tab();
 *
 * Good:
 *   await user.fill(input, "hello");
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-user-clear-tab",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow user.clear() and user.tab() — use user.fill() instead",
    },
    schema: [],
    messages: {
      noClear:
        "Do not use user.clear(). Use the fill(element, value) helper from page-helper.ts instead — it selects all and types with delay:null for fast, correct input replacement.",
      noTab:
        "Do not use user.tab(). Use fill(element, value) for input changes, or element.blur() / user.click(target) to move focus explicitly.",
    },
  },
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        const prop = node.callee.property;
        if (prop.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        if (prop.name === "clear") {
          context.report({ node, messageId: "noClear" });
        } else if (prop.name === "tab") {
          context.report({ node, messageId: "noTab" });
        }
      },
    };
  },
});
