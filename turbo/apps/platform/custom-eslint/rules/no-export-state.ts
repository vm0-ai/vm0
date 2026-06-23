/**
 * ESLint rule: no-export-state
 *
 * Prevents direct export of state() calls. State should be wrapped
 * in a module pattern or accessed through selectors.
 *
 * Bad: export const count$ = state(0)
 * Bad: export interface FooSignals { state$: State<Foo> }
 * Good: const count$ = state(0); export const getCount = () => count$;
 */

import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, findTypeRefPath } from "../utils.ts";

type MessageIds = "noExportState" | "noExportStateType";

const STATE_TYPES = new Set(["State"]);

export default createRule<[], MessageIds>({
  name: "no-export-state",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct export of state() calls and State types",
    },
    schema: [],
    messages: {
      noExportState:
        "Do not export state() directly. Wrap it in a module pattern or use selectors.",
      noExportStateType:
        "Do not expose ccstate State in exported types. Use computed() for reads and command() for writes.",
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

    function reportIfStateType(
      node: TSESTree.Node,
      typeNode: TSESTree.TypeNode,
    ): void {
      if (findTypeRefPath(typeNode, STATE_TYPES) === null) {
        return;
      }
      context.report({
        node,
        messageId: "noExportStateType",
      });
    }

    function checkInterfaceDeclaration(
      node: TSESTree.TSInterfaceDeclaration,
    ): void {
      for (const member of node.body.body) {
        if (member.type === "TSPropertySignature" && member.typeAnnotation) {
          reportIfStateType(member, member.typeAnnotation.typeAnnotation);
        }
      }
    }

    function checkTypeAliasDeclaration(
      node: TSESTree.TSTypeAliasDeclaration,
    ): void {
      reportIfStateType(node, node.typeAnnotation);
    }

    function checkExportNamedDeclaration(
      node: TSESTree.ExportNamedDeclaration,
    ): void {
      const declaration = node.declaration;
      if (!declaration) {
        return;
      }

      if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (isStateCall(declarator.init)) {
            context.report({
              node: declarator,
              messageId: "noExportState",
            });
          }
        }
        return;
      }

      if (declaration.type === "TSInterfaceDeclaration") {
        checkInterfaceDeclaration(declaration);
        return;
      }

      if (declaration.type === "TSTypeAliasDeclaration") {
        checkTypeAliasDeclaration(declaration);
      }
    }

    return {
      ExportNamedDeclaration: checkExportNamedDeclaration,
    };
  },
});
