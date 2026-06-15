import { ESLintUtils } from "@typescript-eslint/utils";

export interface RuleDocs {
  readonly description: string;
  readonly recommended?: boolean;
  readonly requiresTypeChecking?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>((name) => {
  return `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`;
});
