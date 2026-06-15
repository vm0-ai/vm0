/**
 * ESLint rule: no-test-delay
 *
 * Disallows manual delay/timer patterns in test files. Tests should use
 * createDeferredPromise for controlling async flow and vi.waitFor/waitFor
 * for assertions.
 *
 * Detects:
 * 1. Importing `delay` from `signal-timers`
 * 2. Importing `delay` from `msw`
 * 3. Calling `setTimeout()`
 * 4. Calling `setInterval()`
 *
 * Bad:
 *   import { delay } from "signal-timers";
 *   import { delay } from "msw";
 *   await delay(100);
 *   setTimeout(() => {}, 100);
 *   setInterval(() => {}, 100);
 *
 * Good:
 *   import { createDeferredPromise } from "../../signals/utils.ts";
 *   const deferred = createDeferredPromise(context.signal);
 *   await vi.waitFor(() => { expect(...).toBe(...); });
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const MESSAGE =
  "Do not use manual delays or timers in tests. Use createDeferredPromise to control async flow in MSW handlers, and vi.waitFor/waitFor for assertions.";

export default createRule({
  name: "no-test-delay",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow manual delay/timer patterns in tests",
    },
    schema: [],
    messages: {
      noDelayImport: MESSAGE,
      noSetTimeout: MESSAGE,
      noSetInterval: MESSAGE,
    },
  },
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;
        if (source !== "signal-timers" && source !== "msw") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.imported.type === AST_NODE_TYPES.Identifier &&
            specifier.imported.name === "delay"
          ) {
            context.report({ node: specifier, messageId: "noDelayImport" });
          }
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        if (node.callee.name === "setTimeout") {
          context.report({ node, messageId: "noSetTimeout" });
        }
        if (node.callee.name === "setInterval") {
          context.report({ node, messageId: "noSetInterval" });
        }
      },
    };
  },
});
