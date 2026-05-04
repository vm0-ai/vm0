/**
 * ESLint rule: require-accept
 *
 * Enforces that all ts-rest client method calls obtained via
 * `get(zeroClient$)(contract)` in src/signals/** are wrapped in `accept()`.
 *
 * Good:
 *   const createClient = get(zeroClient$);
 *   const client = createClient(someContract);
 *   const result = await accept(client.get(), [200]);
 *
 * Bad:
 *   const createClient = get(zeroClient$);
 *   const client = createClient(someContract);
 *   const result = await client.get(); // not wrapped in accept()
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "require-accept",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce that zeroClient$ calls are wrapped in accept(). See /ccstate documentation.",
    },
    schema: [],
    messages: {
      requireAccept:
        "zeroClient$ calls must be wrapped in `accept()`. See /ccstate documentation.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (
      !filename.includes("/src/signals/") ||
      filename.includes("/__tests__/")
    ) {
      return {};
    }

    // Variable names bound to: get(zeroClient$)
    const factoryVars = new Set<string>();
    // Variable names bound to: factory(someContract)
    const clientVars = new Set<string>();

    function isGetZeroClientCall(
      node: TSESTree.Node | null | undefined,
    ): boolean {
      if (!node || node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const call = node as TSESTree.CallExpression;
      return (
        call.callee.type === AST_NODE_TYPES.Identifier &&
        call.callee.name === "get" &&
        call.arguments.length === 1 &&
        call.arguments[0].type === AST_NODE_TYPES.Identifier &&
        (call.arguments[0] as TSESTree.Identifier).name === "zeroClient$"
      );
    }

    function isFactoryCall(node: TSESTree.Node | null | undefined): boolean {
      if (!node || node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const call = node as TSESTree.CallExpression;
      return (
        call.callee.type === AST_NODE_TYPES.Identifier &&
        factoryVars.has((call.callee as TSESTree.Identifier).name)
      );
    }

    function isInlineClientCall(
      node: TSESTree.Node | null | undefined,
    ): boolean {
      // get(zeroClient$)(contract) or factory(contract) inline
      if (!node || node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const call = node as TSESTree.CallExpression;
      if (isGetZeroClientCall(call.callee)) {
        return true;
      }
      // factory(contract) where factory is in factoryVars
      return (
        call.callee.type === AST_NODE_TYPES.Identifier &&
        factoryVars.has((call.callee as TSESTree.Identifier).name)
      );
    }

    function isWrappedInAccept(node: TSESTree.CallExpression): boolean {
      const parent = node.parent;
      if (!parent || parent.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const parentCall = parent as TSESTree.CallExpression;
      return (
        parentCall.callee.type === AST_NODE_TYPES.Identifier &&
        (parentCall.callee as TSESTree.Identifier).name === "accept" &&
        parentCall.arguments.length > 0 &&
        parentCall.arguments[0] === node
      );
    }

    return {
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        if (node.id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        const name = (node.id as TSESTree.Identifier).name;

        if (isGetZeroClientCall(node.init)) {
          factoryVars.add(name);
          return;
        }
        if (isFactoryCall(node.init)) {
          clientVars.add(name);
        }
      },

      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        const member = node.callee as TSESTree.MemberExpression;

        // Determine if the object is a tracked client variable or inline pattern
        const objectIsClient =
          (member.object.type === AST_NODE_TYPES.Identifier &&
            clientVars.has((member.object as TSESTree.Identifier).name)) ||
          isInlineClientCall(member.object);

        if (!objectIsClient) {
          return;
        }

        if (isWrappedInAccept(node)) {
          return;
        }

        context.report({ node, messageId: "requireAccept" });
      },
    };
  },
});
