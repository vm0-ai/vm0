/**
 * ESLint rule: no-request-json-as
 *
 * Prevents `(await request.json()) as T` type assertions in route files.
 * Use Zod safeParse() instead for runtime input validation.
 *
 * Good:
 *   const result = schema.safeParse(await request.json());
 *
 * Bad:
 *   const body = (await request.json()) as { email: string };
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-request-json-as",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type assertions on request.json(). Use Zod safeParse() instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noRequestJsonAs:
        "Use Zod safeParse() instead of type assertion on request.json(). See CASA-APP-001.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node: TSESTree.TSAsExpression) {
        const expr = node.expression;

        // Must be an AwaitExpression
        if (expr.type !== AST_NODE_TYPES.AwaitExpression) {
          return;
        }

        const callExpr = expr.argument;

        // Must be a CallExpression
        if (callExpr.type !== AST_NODE_TYPES.CallExpression) {
          return;
        }

        const callee = callExpr.callee;

        // Must be a MemberExpression like request.json()
        if (
          callee.type !== AST_NODE_TYPES.MemberExpression ||
          callee.object.type !== AST_NODE_TYPES.Identifier ||
          callee.object.name !== "request" ||
          callee.property.type !== AST_NODE_TYPES.Identifier ||
          callee.property.name !== "json"
        ) {
          return;
        }

        context.report({
          node,
          messageId: "noRequestJsonAs",
        });
      },
    };
  },
});
