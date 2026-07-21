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

interface NullPredicateMatch {
  helper: "isNull" | "isNotNull";
  length: number;
}

function nullPredicateMatch(quasi: string): NullPredicateMatch | undefined {
  const match = /^\s*IS\s+(NOT\s+)?NULL\b/i.exec(quasi);
  if (match === null) {
    return undefined;
  }
  return {
    helper: match[1] === undefined ? "isNull" : "isNotNull",
    length: match[0].length,
  };
}

function hasPredicateLeftBoundary(quasi: string): boolean {
  const prefix = quasi.trimEnd();
  return (
    prefix === "" ||
    prefix.endsWith("(") ||
    /\b(?:AND|HAVING|NOT|ON|OR|WHEN|WHERE)$/i.test(prefix)
  );
}

function removeRightOperandPostfix(quasi: string): string | undefined {
  let suffix = quasi;
  while (/^\s*::/.test(suffix)) {
    const cast =
      /^\s*::\s*[a-z_][\w$]*(?:\s*\.\s*[a-z_][\w$]*)?(?:\s*\([^()]*\))?(?:\s*\[\s*\])*/i.exec(
        suffix,
      );
    if (cast === null) {
      return undefined;
    }
    suffix = suffix.slice(cast[0].length);
  }

  const timeZone = /^\s+AT\s+TIME\s+ZONE\s+'(?:''|[^'])*'/i.exec(suffix);
  if (timeZone !== null) {
    suffix = suffix.slice(timeZone[0].length);
  }
  return suffix;
}

function hasPredicateRightBoundary(quasi: string): boolean {
  const withoutPostfix = removeRightOperandPostfix(quasi);
  if (withoutPostfix === undefined) {
    return false;
  }
  const suffix = withoutPostfix.trimStart();
  return (
    suffix === "" ||
    /^[),;]/.test(suffix) ||
    /^(?:AND|ELSE|END|EXCEPT|FETCH|FOR|FULL|GROUP|HAVING|INNER|INTERSECT|LEFT|LIMIT|OFFSET|ON|OR|ORDER|RETURNING|RIGHT|THEN|UNION|WHEN|WHERE)\b/i.test(
      suffix,
    )
  );
}

export const preferDrizzleApis = createRule({
  name: "prefer-drizzle-apis",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer schema-aware Drizzle APIs for exactly equivalent SQL leaves",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      typedApi: "Use Drizzle {{helper}}(...) for this equivalent SQL-tag leaf.",
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

    function report(node: TSESTree.Node, helper: string): void {
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
        for (let index = 0; index < expressions.length - 1; index += 1) {
          if (
            !hasPredicateLeftBoundary(quasis[index] ?? "") ||
            !hasPredicateRightBoundary(quasis[index + 2] ?? "")
          ) {
            continue;
          }
          const helper = COMPARISON_HELPERS.get(
            quasis[index + 1]?.trim() ?? "",
          );
          if (helper !== undefined) {
            const leftExpression = expressions[index];
            const left = expressionType(leftExpression);
            if (isDrizzleWrapperType(checker, left.type)) {
              report(leftExpression, helper);
            }
          }
        }

        for (let index = 0; index < expressions.length; index += 1) {
          const match = nullPredicateMatch(quasis[index + 1] ?? "");
          if (
            match === undefined ||
            !hasPredicateLeftBoundary(quasis[index] ?? "") ||
            !hasPredicateRightBoundary(
              (quasis[index + 1] ?? "").slice(match.length),
            )
          ) {
            continue;
          }
          const expressionNode = expressions[index];
          const expression = expressionType(expressionNode);
          if (isDrizzleWrapperType(checker, expression.type)) {
            report(expressionNode, match.helper);
          }
        }

        if (expressions.length !== 1 || quasis.length !== 2) {
          return;
        }

        const expression = expressionType(expressions[0]);
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
