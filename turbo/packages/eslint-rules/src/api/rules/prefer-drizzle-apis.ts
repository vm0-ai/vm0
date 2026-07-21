import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { type Node, type Type } from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleSqlTag,
  isDrizzleWrapperType,
} from "../drizzle.ts";
import { createRule } from "../utils.ts";

const COMPARISON_HELPERS = new Map<string, string>([
  ["=", "eq"],
  ["<>", "ne"],
  [">", "gt"],
  [">=", "gte"],
  ["<", "lt"],
  ["<=", "lte"],
]);

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

export const preferDrizzleApis = createRule({
  name: "prefer-drizzle-apis",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer schema-aware Drizzle APIs for exactly equivalent SQL tags",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      typedApi:
        "Use Drizzle {{helper}}(...) instead of an equivalent sql tagged template.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function expressionType(node: TSESTree.Expression): {
      readonly location: Node;
      readonly type: Type;
    } {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return {
        location: tsNode,
        type: checker.getTypeAtLocation(tsNode),
      };
    }

    function report(
      node: TSESTree.TaggedTemplateExpression,
      helper: string,
    ): void {
      context.report({
        node,
        messageId: "typedApi",
        data: { helper },
      });
    }

    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (!isDrizzleSqlTag(checker, services, node.tag)) {
          return;
        }

        const quasis = node.quasi.quasis.map(quasiText);
        const expressions = node.quasi.expressions;
        if (
          expressions.length === 2 &&
          quasis.length === 3 &&
          quasis[0]?.trim() === "" &&
          quasis[2]?.trim() === ""
        ) {
          const helper = COMPARISON_HELPERS.get(quasis[1]?.trim() ?? "");
          if (helper !== undefined) {
            const left = expressionType(expressions[0]);
            if (isDrizzleWrapperType(checker, left.type)) {
              report(node, helper);
            }
          }
          return;
        }

        if (expressions.length !== 1 || quasis.length !== 2) {
          return;
        }
        const expression = expressionType(expressions[0]);
        const suffix = quasis[1]?.trim().replaceAll(/\s+/g, " ").toUpperCase();
        if (
          quasis[0]?.trim() === "" &&
          (suffix === "IS NULL" || suffix === "IS NOT NULL") &&
          isDrizzleWrapperType(checker, expression.type)
        ) {
          report(node, suffix === "IS NULL" ? "isNull" : "isNotNull");
          return;
        }

        const prefix = quasis[0] ?? "";
        const aggregateSuffix = quasis[1] ?? "";
        const aggregate = /^\s*(MAX|MIN)\s*\(\s*$/i.exec(prefix);
        if (
          aggregate !== null &&
          /^\s*\)\s*$/.test(aggregateSuffix) &&
          isDrizzleColumnType(checker, expression.type, expression.location)
        ) {
          report(node, aggregate[1]?.toLowerCase() ?? "");
        }
      },
    };
  },
});
