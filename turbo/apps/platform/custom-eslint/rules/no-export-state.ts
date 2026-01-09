/**
 * ESLint rule: no-export-state
 *
 * Prevents direct export of state() calls. State should be wrapped
 * in a module pattern or accessed through selectors.
 *
 * Bad: export const count$ = state(0)
 * Good: const count$ = state(0); export const getCount = () => count$;
 */

import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noExportState";

export default createRule<[], MessageIds>({
  name: "no-export-state",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct export of state() calls",
    },
    schema: [],
    messages: {
      noExportState:
        "Do not export state() directly. Wrap it in a module pattern or use selectors.",
    },
  },
  defaultOptions: [],
  create(context) {
    function isStateCall(node: TSESTree.Node | null | undefined): boolean {
      if (!node || node.type !== "CallExpression") {
        return false;
      }

      const callee = node.callee;
      return callee.type === "Identifier" && callee.name === "state";
    }

    function checkExportNamedDeclaration(
      node: TSESTree.ExportNamedDeclaration,
    ): void {
      const declaration = node.declaration;
      if (!declaration || declaration.type !== "VariableDeclaration") {
        return;
      }

      for (const declarator of declaration.declarations) {
        if (isStateCall(declarator.init)) {
          context.report({
            node: declarator,
            messageId: "noExportState",
          });
        }
      }
    }

    return {
      ExportNamedDeclaration: checkExportNamedDeclaration,
    };
  },
});
