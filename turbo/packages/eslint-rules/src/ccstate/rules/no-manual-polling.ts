import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function isLoop(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.WhileStatement ||
    node.type === AST_NODE_TYPES.DoWhileStatement ||
    node.type === AST_NODE_TYPES.ForStatement ||
    node.type === AST_NODE_TYPES.ForOfStatement ||
    node.type === AST_NODE_TYPES.ForInStatement
  );
}

export default createRule({
  name: "no-manual-polling",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Use setLoop instead of handwritten loops with delays",
    },
    schema: [],
    messages: {
      manualPolling:
        "Do not poll with a loop and sleep/delay. Use setLoop with an owning AbortSignal, or await an event/completion signal in tests.",
    },
  },
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        let name: string | undefined;
        if (callee.type === AST_NODE_TYPES.Identifier) {
          name = callee.name;
          const variable = ASTUtils.findVariable(
            context.sourceCode.getScope(callee),
            callee,
          );
          const definition = variable?.defs[0];
          if (
            definition?.type === "ImportBinding" &&
            definition.node.type === AST_NODE_TYPES.ImportSpecifier
          ) {
            const imported = definition.node.imported;
            name =
              imported.type === AST_NODE_TYPES.Identifier
                ? imported.name
                : imported.value;
          }
        } else if (callee.type === AST_NODE_TYPES.MemberExpression) {
          if (
            !callee.computed &&
            callee.property.type === AST_NODE_TYPES.Identifier
          ) {
            name = callee.property.name;
          } else if (
            callee.property.type === AST_NODE_TYPES.Literal &&
            typeof callee.property.value === "string"
          ) {
            name = callee.property.value;
          }
        }
        if (!name || !["delay", "sleep", "setTimeout"].includes(name)) {
          return;
        }
        let parent: TSESTree.Node | undefined = node.parent;
        while (parent) {
          if (isLoop(parent)) {
            context.report({ node, messageId: "manualPolling" });
            return;
          }
          if (
            parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            parent.type === AST_NODE_TYPES.FunctionExpression ||
            parent.type === AST_NODE_TYPES.FunctionDeclaration
          ) {
            return;
          }
          parent = parent.parent;
        }
      },
    };
  },
});
