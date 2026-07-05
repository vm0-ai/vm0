/**
 * ESLint rule: no-getter-setter-params
 *
 * Regular functions must not accept ccstate Getter or Setter types as
 * parameters. If a function needs get/set access, it should be a command.
 *
 * Good:
 *   const myCommand$ = command(({ get, set }) => { ... });
 *
 * Bad:
 *   function helper(get: Getter, set: Setter, value: string) { ... }
 *   async function doWork(args: { set: Setter; value: string }) { ... }
 *
 * Known limitation: structural aliases such as
 * `type GetAccessor = <T>(atom: Computed<T>) => T` are not resolvable without
 * type information. ccstate/no-accessor-escape enforces the call-site boundary.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule, findTypeRefPath } from "../utils.ts";

type MessageIds = "noGetterSetterParam" | "noGetterSetterObjectParam";

const ACCESSOR_TYPES = new Set(["Getter", "Setter"]);

export default createRule<[], MessageIds>({
  name: "no-getter-setter-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not accept ccstate Getter or Setter types as parameters — use command() instead",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noGetterSetterParam:
        "Parameter '{{name}}' has type '{{type}}' from ccstate. Use command() instead of passing Getter/Setter to functions.",
      noGetterSetterObjectParam:
        "Parameter '{{name}}' contains type '{{type}}' from ccstate in object property '{{property}}'. Use command() instead of passing Getter/Setter to functions.",
    },
  },

  create(context) {
    function getParamName(param: TSESTree.Parameter): string {
      return param.type === AST_NODE_TYPES.Identifier
        ? param.name
        : "parameter";
    }

    function getTypeAnnotation(
      param: TSESTree.Parameter,
    ): TSESTree.TypeNode | null {
      if ("typeAnnotation" in param && param.typeAnnotation) {
        return param.typeAnnotation.typeAnnotation;
      }
      return null;
    }

    function checkParam(param: TSESTree.Parameter) {
      const ann = getTypeAnnotation(param);
      if (!ann) {
        return;
      }

      const accessorRef = findTypeRefPath(ann, ACCESSOR_TYPES);
      if (accessorRef === null) {
        return;
      }

      if (accessorRef.path.length === 0) {
        context.report({
          node: param,
          messageId: "noGetterSetterParam",
          data: { name: getParamName(param), type: accessorRef.name },
        });
        return;
      }

      context.report({
        node: param,
        messageId: "noGetterSetterObjectParam",
        data: {
          name: getParamName(param),
          type: accessorRef.name,
          property: accessorRef.path.join("."),
        },
      });
    }

    function checkFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ) {
      for (const param of node.params) {
        checkParam(param);
      }
    }

    return {
      "FunctionDeclaration, ArrowFunctionExpression"(
        node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression,
      ) {
        checkFunction(node);
      },
      "FunctionExpression:not(MethodDefinition > FunctionExpression)"(
        node: TSESTree.FunctionExpression,
      ) {
        checkFunction(node);
      },
      MethodDefinition(node) {
        if (node.value.type === AST_NODE_TYPES.FunctionExpression) {
          checkFunction(node.value);
        }
      },
    };
  },
});
