/**
 * ESLint rule: no-onclick
 *
 * Disallows `onClick` JSX props on interactive elements in view files.
 * On mobile browsers, `onClick` has a ~300ms tap delay and can be swallowed
 * by scroll gestures. Use `onPointerDown` instead for immediate response on
 * both touch and mouse devices.
 *
 * Good:
 *   <button onPointerDown={handleSend}>Send</button>
 *   <div onPointerDown={() => openMenu()}>Menu</div>
 *
 * Bad:
 *   <button onClick={handleSend}>Send</button>
 *   <div onClick={() => openMenu()}>Menu</div>
 *
 * Note: `onClick` on <a href> and <form> elements is still allowed because
 * those rely on native browser click semantics for keyboard and accessibility.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

// Elements where onClick is acceptable for native browser / a11y semantics
const ALLOWED_ELEMENTS = new Set(["a", "form", "label"]);

export default createRule({
  name: "no-onclick",
  defaultOptions: [],
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Disallow onClick on JSX elements — use onPointerDown for mobile-safe event handling",
    },
    schema: [],
    messages: {
      noOnClick:
        "Use `onPointerDown` instead of `onClick`. On mobile, `onClick` has a ~300ms delay and may be swallowed by scroll gestures.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (
          node.name.type !== AST_NODE_TYPES.JSXIdentifier ||
          node.name.name !== "onClick"
        ) {
          return;
        }

        // Check if the parent JSX element is in the allowed list
        const openingElement = node.parent;
        if (openingElement.type !== AST_NODE_TYPES.JSXOpeningElement) {
          return;
        }

        const elementName = openingElement.name;
        if (
          elementName.type === AST_NODE_TYPES.JSXIdentifier &&
          ALLOWED_ELEMENTS.has(elementName.name)
        ) {
          return;
        }

        context.report({
          node,
          messageId: "noOnClick",
          fix(fixer) {
            return fixer.replaceText(node.name, "onPointerDown");
          },
        });
      },
    };
  },
});
