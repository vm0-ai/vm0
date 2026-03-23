/**
 * ESLint rule: no-self-api-call
 *
 * Prevents API routes from calling other API routes on the same Next.js
 * server via HTTP. This causes unnecessary network round-trips and makes
 * the call chain harder to trace.
 *
 * Detects:
 * - Imports of createInfraClient / proxyToInfra from infra-client
 *
 * Good:
 *   // Call the underlying logic directly
 *   const result = await someService.create(body);
 *
 * Bad:
 *   import { createInfraClient } from "../../src/lib/infra-client";
 *   const client = createInfraClient(contract, auth);
 *   const result = await client.create({ body });
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-self-api-call",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow API routes from calling other API routes on the same server via HTTP.",
      recommended: true,
    },
    schema: [],
    messages: {
      noSelfApiCall:
        "Do not call the same Next.js server's API routes via HTTP. Import and call the underlying logic directly instead of using {{ name }}.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;
        if (typeof source !== "string" || !source.endsWith("/infra-client")) {
          return;
        }

        const flaggedNames: string[] = [];
        for (const specifier of node.specifiers) {
          if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.imported.type === AST_NODE_TYPES.Identifier &&
            (specifier.imported.name === "createInfraClient" ||
              specifier.imported.name === "proxyToInfra")
          ) {
            flaggedNames.push(specifier.imported.name);
          }
        }

        if (flaggedNames.length > 0) {
          context.report({
            node,
            messageId: "noSelfApiCall",
            data: { name: flaggedNames.join(", ") },
          });
        }
      },
    };
  },
});
