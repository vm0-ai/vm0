/**
 * ESLint rule: no-direct-db-in-tests
 *
 * Prevents direct database access in test files. Tests should create
 * and verify data through API endpoints and helpers, not by directly
 * reading/writing the database.
 *
 * Detects:
 * - globalThis.services.db  (direct DB access)
 * - initServices()          (sign of direct service access)
 *
 * Good:
 *   const response = await GET(request);
 *   const { composeId } = await createTestCompose("agent");
 *
 * Bad:
 *   await globalThis.services.db.insert(users).values({...});
 *   initServices();
 *   const db = globalThis.services.db;
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-direct-db-in-tests",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct database access in test files. Use API helpers instead.",
      recommended: true,
    },
    schema: [],
    messages: {
      noDirectDb:
        "Do not use globalThis.services.db in test files. Use API helpers instead. See docs/testing/web-testing.md#avoid-db-operations",
      noInitServices:
        "Do not call initServices() in test files. Route handlers call it internally. See docs/testing/web-testing.md#no-initservices-in-route-tests",
    },
  },
  create(context) {
    return {
      // Detect globalThis.services.db
      MemberExpression(node: TSESTree.MemberExpression) {
        if (
          node.property.type === AST_NODE_TYPES.Identifier &&
          node.property.name === "db" &&
          node.object.type === AST_NODE_TYPES.MemberExpression &&
          node.object.property.type === AST_NODE_TYPES.Identifier &&
          node.object.property.name === "services" &&
          node.object.object.type === AST_NODE_TYPES.Identifier &&
          node.object.object.name === "globalThis"
        ) {
          context.report({
            node,
            messageId: "noDirectDb",
          });
        }
      },

      // Detect initServices()
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "initServices"
        ) {
          context.report({
            node,
            messageId: "noInitServices",
          });
        }
      },
    };
  },
});
