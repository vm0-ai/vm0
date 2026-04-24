/**
 * ESLint rule: require-client-signal
 *
 * In src/signals/**, any async non-computed function that accepts an
 * AbortSignal and calls a ts-rest client obtained from zeroClient$ must pass
 * that signal via `fetchOptions: { signal }`.
 *
 * Good:
 *   command(async ({ get }, signal: AbortSignal) => {
 *     const client = get(zeroClient$)(contract);
 *     await accept(client.get({ fetchOptions: { signal } }), [200]);
 *   });
 *
 * Bad:
 *   command(async ({ get }, signal: AbortSignal) => {
 *     const client = get(zeroClient$)(contract);
 *     await accept(client.get(), [200]);
 *   });
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

interface FunctionContext {
  signalName: string;
  signalAliases: Set<string>;
  factoryVars: Set<string>;
  clientVars: Set<string>;
}

export default createRule({
  name: "require-client-signal",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce that zeroClient$ calls inside async signal-bearing functions pass fetchOptions.signal",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      missingFetchOptions:
        "zeroClient$ calls in async signal-bearing functions must pass `fetchOptions: { {{signalName}} }`.",
      missingSignal:
        "zeroClient$ calls in async signal-bearing functions must pass `fetchOptions.signal` using `{{signalName}}`.",
      wrongSignal:
        "zeroClient$ calls in async signal-bearing functions must pass the current signal `{{signalName}}` as `fetchOptions.signal`.",
    },
  },

  create(context) {
    const filename = (context.filename || context.getFilename()).replace(
      /\\/g,
      "/",
    );
    if (
      filename !== "<input>" &&
      (!filename.includes("/src/signals/") || filename.includes("/__tests__/"))
    ) {
      return {};
    }

    const functionStack: FunctionContext[] = [];

    function isAbortSignalAnnotation(
      param: TSESTree.Parameter,
    ): param is TSESTree.Identifier {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const ann = param.typeAnnotation?.typeAnnotation;
      return (
        ann !== undefined &&
        ann.type === AST_NODE_TYPES.TSTypeReference &&
        ann.typeName.type === AST_NODE_TYPES.Identifier &&
        ann.typeName.name === "AbortSignal"
      );
    }

    function isComputedCallback(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): boolean {
      const parent = node.parent;
      return (
        parent?.type === AST_NODE_TYPES.CallExpression &&
        parent.callee.type === AST_NODE_TYPES.Identifier &&
        parent.callee.name === "computed"
      );
    }

    function getSignalName(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): string | null {
      for (const param of node.params) {
        if (isAbortSignalAnnotation(param)) {
          return param.name;
        }
      }
      return null;
    }

    function currentFunction(): FunctionContext | undefined {
      return functionStack[functionStack.length - 1];
    }

    function isGetZeroClientCall(
      node: TSESTree.Node | null | undefined,
    ): boolean {
      return (
        node?.type === AST_NODE_TYPES.CallExpression &&
        node.callee.type === AST_NODE_TYPES.Identifier &&
        node.callee.name === "get" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === AST_NODE_TYPES.Identifier &&
        node.arguments[0].name === "zeroClient$"
      );
    }

    function isFactoryCall(
      node: TSESTree.Node | null | undefined,
      current: FunctionContext,
    ): boolean {
      return (
        node?.type === AST_NODE_TYPES.CallExpression &&
        node.callee.type === AST_NODE_TYPES.Identifier &&
        current.factoryVars.has(node.callee.name)
      );
    }

    function isInlineClientFactoryCall(
      node: TSESTree.Node | null | undefined,
      current: FunctionContext,
    ): boolean {
      return (
        node?.type === AST_NODE_TYPES.CallExpression &&
        (isGetZeroClientCall(node.callee) ||
          (node.callee.type === AST_NODE_TYPES.Identifier &&
            current.factoryVars.has(node.callee.name)))
      );
    }

    function getPropertyByName(
      node: TSESTree.ObjectExpression,
      name: string,
    ): TSESTree.Property | null {
      for (const prop of node.properties) {
        if (
          prop.type === AST_NODE_TYPES.Property &&
          !prop.computed &&
          prop.key.type === AST_NODE_TYPES.Identifier &&
          prop.key.name === name
        ) {
          return prop;
        }
      }
      return null;
    }

    function getSignalIdentifierName(
      node: TSESTree.Property["value"],
    ): string | null {
      if (node.type === AST_NODE_TYPES.Identifier) {
        return node.name;
      }
      if (
        node.type === AST_NODE_TYPES.ObjectExpression &&
        node.properties.length === 1
      ) {
        const prop = node.properties[0];
        if (
          prop.type === AST_NODE_TYPES.Property &&
          !prop.computed &&
          prop.shorthand &&
          prop.key.type === AST_NODE_TYPES.Identifier
        ) {
          return prop.key.name;
        }
      }
      return null;
    }

    function expressionReferencesSignalAlias(
      node: TSESTree.Node | null | undefined,
      current: FunctionContext,
    ): boolean {
      if (!node) {
        return false;
      }
      switch (node.type) {
        case AST_NODE_TYPES.Identifier: {
          return current.signalAliases.has(node.name);
        }
        case AST_NODE_TYPES.CallExpression: {
          return (
            expressionReferencesSignalAlias(node.callee, current) ||
            node.arguments.some((arg) => {
              return expressionReferencesSignalAlias(arg, current);
            })
          );
        }
        case AST_NODE_TYPES.MemberExpression: {
          return (
            expressionReferencesSignalAlias(node.object, current) ||
            (node.computed &&
              expressionReferencesSignalAlias(node.property, current))
          );
        }
        case AST_NODE_TYPES.ArrayExpression: {
          return node.elements.some((element) => {
            return expressionReferencesSignalAlias(element, current);
          });
        }
        case AST_NODE_TYPES.ObjectExpression: {
          return node.properties.some((prop) => {
            if (prop.type !== AST_NODE_TYPES.Property) {
              return false;
            }
            return (
              (prop.computed &&
                expressionReferencesSignalAlias(prop.key, current)) ||
              expressionReferencesSignalAlias(prop.value, current)
            );
          });
        }
        case AST_NODE_TYPES.ChainExpression: {
          return expressionReferencesSignalAlias(node.expression, current);
        }
        case AST_NODE_TYPES.TSAsExpression:
        case AST_NODE_TYPES.TSTypeAssertion: {
          return expressionReferencesSignalAlias(node.expression, current);
        }
        default: {
          return false;
        }
      }
    }

    function checkClientCall(
      node: TSESTree.CallExpression,
      current: FunctionContext,
    ) {
      const [firstArg] = node.arguments;
      if (!firstArg || firstArg.type !== AST_NODE_TYPES.ObjectExpression) {
        context.report({
          node,
          messageId: "missingFetchOptions",
          data: { signalName: current.signalName },
        });
        return;
      }

      const fetchOptionsProp = getPropertyByName(firstArg, "fetchOptions");
      if (
        !fetchOptionsProp ||
        fetchOptionsProp.value.type !== AST_NODE_TYPES.ObjectExpression
      ) {
        context.report({
          node: firstArg,
          messageId: "missingFetchOptions",
          data: { signalName: current.signalName },
        });
        return;
      }

      const signalProp = getPropertyByName(fetchOptionsProp.value, "signal");
      if (!signalProp) {
        context.report({
          node: fetchOptionsProp.value,
          messageId: "missingSignal",
          data: { signalName: current.signalName },
        });
        return;
      }

      const signalIdentifier = getSignalIdentifierName(signalProp.value);
      if (
        signalIdentifier === null ||
        !current.signalAliases.has(signalIdentifier)
      ) {
        context.report({
          node: signalProp.value,
          messageId: "wrongSignal",
          data: { signalName: current.signalName },
        });
      }
    }

    function enterFunction(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ) {
      if (!node.async || isComputedCallback(node)) {
        return;
      }

      const signalName = getSignalName(node);
      if (!signalName) {
        return;
      }

      functionStack.push({
        signalName,
        signalAliases: new Set<string>([signalName]),
        factoryVars: new Set<string>(),
        clientVars: new Set<string>(),
      });
    }

    function exitFunction(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ) {
      if (!node.async || isComputedCallback(node)) {
        return;
      }
      const signalName = getSignalName(node);
      if (!signalName) {
        return;
      }
      functionStack.pop();
    }

    return {
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,

      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        const current = currentFunction();
        if (!current || node.id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (isGetZeroClientCall(node.init)) {
          current.factoryVars.add(node.id.name);
          return;
        }

        if (isFactoryCall(node.init, current)) {
          current.clientVars.add(node.id.name);
          return;
        }

        if (expressionReferencesSignalAlias(node.init, current)) {
          current.signalAliases.add(node.id.name);
        }
      },

      CallExpression(node: TSESTree.CallExpression) {
        const current = currentFunction();
        if (!current || node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const objectIsClient =
          (node.callee.object.type === AST_NODE_TYPES.Identifier &&
            current.clientVars.has(node.callee.object.name)) ||
          isInlineClientFactoryCall(node.callee.object, current);

        if (!objectIsClient) {
          return;
        }

        checkClientCall(node, current);
      },
    };
  },
});
