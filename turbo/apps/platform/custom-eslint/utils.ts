/**
 * Shared utilities for custom ESLint rules.
 */

import {
  isTypeReadonly,
  type TypeOrValueSpecifier,
} from "@typescript-eslint/type-utils";
import {
  ESLintUtils,
  type ParserServicesWithTypeInformation,
} from "@typescript-eslint/utils";
import type { Type, TypeChecker } from "typescript";

interface RuleDocs {
  description: string;
  recommended?: boolean;
  requiresTypeChecking?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

function isEmptyObjectLiteral(type: Type, checker: TypeChecker): boolean {
  return checker.typeToString(type) === "{}";
}

export function isMutableObjectType(
  type: Type,
  services: ParserServicesWithTypeInformation,
  checker: TypeChecker,
  allowedMutableTypes: TypeOrValueSpecifier[] = [],
): boolean {
  return (
    !isTypeReadonly(services.program, type, {
      allow: allowedMutableTypes,
    }) || isEmptyObjectLiteral(type, checker)
  );
}
