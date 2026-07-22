import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { TypeFlags, type Type, type TypeChecker } from "typescript";

import { isDrizzleSqlTag, isDrizzleWrapperType } from "../drizzle.ts";
import { createRule } from "../utils.ts";

type MessageId =
  | "anyInterpolation"
  | "arrayInterpolation"
  | "mixedInterpolation"
  | "undefinedInterpolation"
  | "unknownInterpolation";

function constrainedTypeMembers(
  checker: TypeChecker,
  type: Type,
  visited: Set<Type>,
): Type[] | null {
  if ((type.flags & TypeFlags.TypeParameter) !== 0) {
    if (visited.has(type)) {
      return null;
    }
    visited.add(type);
    const constraint = checker.getBaseConstraintOfType(type);
    const members =
      constraint === undefined
        ? null
        : constrainedTypeMembers(checker, constraint, visited);
    visited.delete(type);
    return members;
  }

  if (!type.isUnion()) {
    return [type];
  }

  const members: Type[] = [];
  for (const member of type.types) {
    const constrainedMembers = constrainedTypeMembers(checker, member, visited);
    if (constrainedMembers === null) {
      return null;
    }
    members.push(...constrainedMembers);
  }
  return members;
}

function interpolationProblem(
  checker: TypeChecker,
  type: Type,
): MessageId | null {
  const members = constrainedTypeMembers(checker, type, new Set<Type>());
  if (members === null) {
    return "unknownInterpolation";
  }
  if (
    members.some((member) => {
      return (member.flags & TypeFlags.Any) !== 0;
    })
  ) {
    return "anyInterpolation";
  }
  if (
    members.some((member) => {
      return (member.flags & TypeFlags.Unknown) !== 0;
    })
  ) {
    return "unknownInterpolation";
  }

  if (
    members.some((member) => {
      return (member.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0;
    })
  ) {
    return "undefinedInterpolation";
  }
  if (
    members.some((member) => {
      return checker.isArrayType(member) || checker.isTupleType(member);
    })
  ) {
    return "arrayInterpolation";
  }
  if (
    members.some((member) => {
      return isDrizzleWrapperType(checker, member);
    }) &&
    members.some((member) => {
      return !isDrizzleWrapperType(checker, member);
    })
  ) {
    return "mixedInterpolation";
  }
  return null;
}

export const noUnsafeSqlInterpolation = createRule({
  name: "no-unsafe-sql-interpolation",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Require unambiguous types in Drizzle SQL interpolations",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      anyInterpolation:
        "Do not interpolate any into Drizzle SQL. Give the value an explicit safe type before constructing SQL.",
      unknownInterpolation:
        "Do not interpolate unknown into Drizzle SQL. Narrow it to a bound value or an explicit SQL wrapper first.",
      undefinedInterpolation:
        "Drizzle omits undefined interpolations. Narrow the value first, or use sql.empty() for an intentionally empty fragment.",
      arrayInterpolation:
        "Drizzle expands a directly interpolated array or tuple as SQL chunks. Use sql.param(...) for one bound value or sql.join(...) for fragments.",
      mixedInterpolation:
        "Do not mix SQL wrappers and bound values in one interpolation type. Convert the value to an explicit parameter or fragment before this boundary.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (!isDrizzleSqlTag(checker, services, node.tag)) {
          return;
        }
        for (const expression of node.quasi.expressions) {
          const tsExpression = services.esTreeNodeToTSNodeMap.get(expression);
          const messageId = interpolationProblem(
            checker,
            checker.getTypeAtLocation(tsExpression),
          );
          if (messageId !== null) {
            context.report({ node: expression, messageId });
          }
        }
      },
    };
  },
});
