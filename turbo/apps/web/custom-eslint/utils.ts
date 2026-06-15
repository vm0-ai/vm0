import { ESLintUtils } from "@typescript-eslint/utils";

export interface RuleDocs {
  description: string;
  recommended?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>(
  (name) => `https://github.com/vm0-ai/vm0/blob/main/docs/eslint/${name}.md`,
);
