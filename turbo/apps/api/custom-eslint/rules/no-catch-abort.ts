import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

function catchClauseHasThrowIfAbort(node: TSESTree.CatchClause): boolean {
  if (!node.param || node.param.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  const firstStatement = node.body.body[0];
  if (firstStatement?.type !== AST_NODE_TYPES.ExpressionStatement) {
    return false;
  }

  const expression = firstStatement.expression;
  if (
    expression.type !== AST_NODE_TYPES.CallExpression ||
    expression.callee.type !== AST_NODE_TYPES.Identifier ||
    expression.callee.name !== "throwIfAbort"
  ) {
    return false;
  }

  const [argument] = expression.arguments;
  return (
    expression.arguments.length === 1 &&
    argument?.type === AST_NODE_TYPES.Identifier &&
    argument.name === node.param.name
  );
}

export const noCatchAbort = createRule({
  name: "no-catch-abort",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Enforce throwIfAbort in catch blocks",
      recommended: true,
    },
    schema: [],
    messages: {
      noCatchAbort:
        "throwIfAbort should be the first statement in catch block.",
    },
  },
  create(context) {
    return {
      CatchClause(node): void {
        if (!catchClauseHasThrowIfAbort(node)) {
          context.report({
            node,
            messageId: "noCatchAbort",
          });
        }
      },
    };
  },
});
