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
      noDbSchemaImport:
        "Do not import from db/schema/* in web test files. Test through route handlers, or move DB-owned tests to @vm0/db.",
      noServiceImport:
        "Do not import service functions directly in test files. Test through route handlers instead. See docs/testing/web-testing.md#acceptable-service-level-test-exceptions",
    },
  },
  create(context) {
    return {
      // Detect imports from db/schema/* and service modules
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;
        if (typeof source !== "string") {
          return;
        }

        // Check db/schema imports
        if (/\/db\/schema\//.test(source)) {
          context.report({
            node,
            messageId: "noDbSchemaImport",
          });
          return;
        }

        // Check service module imports
        // Only flag relative imports (not packages)
        if (!source.startsWith(".")) {
          return;
        }

        // Skip type-only imports (import type { ... } from "...")
        if (node.importKind === "type") {
          return;
        }

        // Skip test infrastructure imports
        if (/__tests__\//.test(source)) {
          return;
        }

        // Flag imports from *-service modules (e.g., "../run-service", "./connect-service")
        // The pattern matches filenames ending with -service (with optional path suffix)
        if (/-service(\/|$)/.test(source)) {
          // Check if ALL specifiers are type-only (inline type imports)
          const hasValueImport = node.specifiers.some((spec) => {
            return (
              spec.type !== AST_NODE_TYPES.ImportSpecifier ||
              spec.importKind !== "type"
            );
          });
          if (hasValueImport) {
            context.report({
              node,
              messageId: "noServiceImport",
            });
          }
        }
      },

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
