import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

// Cap how deep we walk nested object type literals. ccstate options bags are
// shallow in practice, so a small cap keeps the AST-only check cheap while
// still catching the realistic `{ args: { get: Getter } }` nesting.
const MAX_OBJECT_TYPE_DEPTH = 5;

export const noGetterSetterParams = createRule({
  name: "no-getter-setter-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Functions must not accept ccstate Getter or Setter types as parameters",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noGetterSetterParam:
        "Parameter '{{name}}' has type '{{type}}' from ccstate. Use a computed/command factory instead of passing Getter/Setter to functions.",
      noGetterSetterAlias:
        "Do not alias ccstate Getter/Setter; model the helper as computed/command instead.",
    },
  },
  create(context) {
    // Returns the literal "Getter"/"Setter" name of a type-reference node, or
    // null. Used for positional params, object-type members, and alias RHS.
    function getGetterSetterName(node: TSESTree.TypeNode): string | null {
      if (
        node.type === AST_NODE_TYPES.TSTypeReference &&
        node.typeName.type === AST_NODE_TYPES.Identifier &&
        (node.typeName.name === "Getter" || node.typeName.name === "Setter")
      ) {
        return node.typeName.name;
      }
      return null;
    }

    // Walks an object type literal and reports any property signature whose
    // type is literally `Getter`/`Setter`, recursing into nested object
    // literals up to a small depth cap.
    function checkObjectType(
      node: TSESTree.TSTypeLiteral,
      depth: number,
    ): void {
      if (depth > MAX_OBJECT_TYPE_DEPTH) {
        return;
      }

      for (const member of node.members) {
        if (member.type !== AST_NODE_TYPES.TSPropertySignature) {
          continue;
        }

        const memberType = member.typeAnnotation?.typeAnnotation;
        if (!memberType) {
          continue;
        }

        const typeName = getGetterSetterName(memberType);
        if (typeName !== null) {
          const memberName =
            member.key.type === AST_NODE_TYPES.Identifier
              ? member.key.name
              : "(member)";
          context.report({
            node: member,
            messageId: "noGetterSetterParam",
            data: { name: memberName, type: typeName },
          });
          continue;
        }

        if (memberType.type === AST_NODE_TYPES.TSTypeLiteral) {
          checkObjectType(memberType, depth + 1);
        }
      }
    }

    function checkParam(param: TSESTree.Parameter): void {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return;
      }

      const annotation = param.typeAnnotation?.typeAnnotation;
      if (!annotation) {
        return;
      }

      const typeName = getGetterSetterName(annotation);
      if (typeName !== null) {
        context.report({
          node: param,
          messageId: "noGetterSetterParam",
          data: { name: param.name, type: typeName },
        });
        return;
      }

      // Options-bag shape: `args: { readonly get: Getter; set: Setter; ... }`.
      if (annotation.type === AST_NODE_TYPES.TSTypeLiteral) {
        checkObjectType(annotation, 0);
      }
    }

    const ccstatePrimitives = new Set(["command", "computed", "state"]);

    function isInsideCcstateCallback(node: TSESTree.Node): boolean {
      let current: TSESTree.Node | undefined = node.parent;
      while (current) {
        if (
          current.type === AST_NODE_TYPES.CallExpression &&
          current.callee.type === AST_NODE_TYPES.Identifier &&
          ccstatePrimitives.has(current.callee.name)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    function checkFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.FunctionExpression
        | TSESTree.ArrowFunctionExpression,
    ): void {
      if (isInsideCcstateCallback(node)) {
        return;
      }

      for (const param of node.params) {
        checkParam(param);
      }
    }

    // Reports if an alias right-hand side is (or contains via union/
    // intersection) a `Getter`/`Setter` type reference.
    function aliasReferencesGetterSetter(node: TSESTree.TypeNode): boolean {
      if (getGetterSetterName(node) !== null) {
        return true;
      }

      if (
        node.type === AST_NODE_TYPES.TSUnionType ||
        node.type === AST_NODE_TYPES.TSIntersectionType
      ) {
        return node.types.some(aliasReferencesGetterSetter);
      }

      return false;
    }

    function checkTypeAlias(node: TSESTree.TSTypeAliasDeclaration): void {
      if (aliasReferencesGetterSetter(node.typeAnnotation)) {
        context.report({
          node,
          messageId: "noGetterSetterAlias",
        });
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      TSTypeAliasDeclaration: checkTypeAlias,
    };
  },
});
