/**
 * ESLint rule: no-accessor-escape
 *
 * ccstate get/set accessors are scoped capabilities. They must only be called
 * directly inside command()/computed() callbacks, never passed to helpers,
 * stored in objects, aliased, returned, or captured as values.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

type MessageIds = "accessorEscape";

type CallbackNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression;

function isCallbackNode(node: TSESTree.Node): node is CallbackNode {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}

function isDirectCallCallee(node: TSESTree.Identifier): boolean {
  const parent = node.parent;
  return (
    parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node
  );
}

function bindingFromPropertyValue(
  value: TSESTree.Property["value"],
): TSESTree.Identifier | null {
  if (value.type === AST_NODE_TYPES.Identifier) {
    return value;
  }
  if (
    value.type === AST_NODE_TYPES.AssignmentPattern &&
    value.left.type === AST_NODE_TYPES.Identifier
  ) {
    return value.left;
  }
  return null;
}

function commandAccessorBindings(
  callback: CallbackNode,
): TSESTree.Identifier[] {
  const firstParam = callback.params[0];
  if (!firstParam || firstParam.type !== AST_NODE_TYPES.ObjectPattern) {
    return [];
  }

  const bindings: TSESTree.Identifier[] = [];
  for (const property of firstParam.properties) {
    if (
      property.type !== AST_NODE_TYPES.Property ||
      property.key.type !== AST_NODE_TYPES.Identifier ||
      (property.key.name !== "get" && property.key.name !== "set")
    ) {
      continue;
    }
    const binding = bindingFromPropertyValue(property.value);
    if (binding) {
      bindings.push(binding);
    }
  }
  return bindings;
}

function computedAccessorBindings(
  callback: CallbackNode,
): TSESTree.Identifier[] {
  const firstParam = callback.params[0];
  return firstParam?.type === AST_NODE_TYPES.Identifier ? [firstParam] : [];
}

export default createRule<[], MessageIds>({
  name: "no-accessor-escape",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent ccstate get/set accessors from escaping command()/computed() callbacks",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      accessorEscape:
        "ccstate accessor '{{name}}' must only be called directly; do not pass, store, return, alias, or wrap it.",
    },
  },

  create(context) {
    function checkCallback(
      primitive: "command" | "computed",
      callback: CallbackNode,
    ) {
      const bindings =
        primitive === "command"
          ? commandAccessorBindings(callback)
          : computedAccessorBindings(callback);
      if (bindings.length === 0) {
        return;
      }

      const bindingNames = new Set(
        bindings.map((binding) => {
          return binding.name;
        }),
      );
      const variables = context.sourceCode.getDeclaredVariables(callback);

      for (const variable of variables) {
        if (!bindingNames.has(variable.name)) {
          continue;
        }
        for (const reference of variable.references) {
          const identifier = reference.identifier;
          if (identifier.type !== AST_NODE_TYPES.Identifier) {
            continue;
          }
          if (isDirectCallCallee(identifier)) {
            continue;
          }
          context.report({
            node: identifier,
            messageId: "accessorEscape",
            data: { name: identifier.name },
          });
        }
      }
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          (node.callee.name !== "command" && node.callee.name !== "computed")
        ) {
          return;
        }

        const callback = node.arguments[0];
        if (!callback || !isCallbackNode(callback)) {
          return;
        }

        checkCallback(node.callee.name, callback);
      },
    };
  },
});
