/**
 * ESLint rule: no-non-zero-api
 *
 * Enforces that the platform app only calls /api/zero/ endpoints.
 * Catches string literals and template literals containing /api/ paths
 * that do not start with /api/zero/.
 *
 * Good: "/api/zero/billing/status"
 * Bad: "/api/billing/status"
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "nonZeroApi";

/**
 * Check if a string contains a non-zero API path.
 * Matches /api/ followed by anything that is NOT zero/.
 * Ignores external URLs (e.g. https://slack.com/api/...).
 */
function containsNonZeroApiPath(value: string): boolean {
  // Skip external URLs — only flag paths starting with /api/ or relative paths
  // that look like our API (not full URLs to third-party services)
  if (/https?:\/\/[^/]+\/api\//.test(value)) {
    return false;
  }
  // Match /api/ that is NOT followed by zero/
  return /\/api\/(?!zero\/)/.test(value);
}

export default createRule<[], MessageIds>({
  name: "no-non-zero-api",
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that platform app only calls /api/zero/ endpoints",
    },
    schema: [],
    messages: {
      nonZeroApi:
        "Platform app must only call /api/zero/ endpoints. Found non-zero API path: '{{path}}'. Use a zero contract + route instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        if (containsNonZeroApiPath(node.value)) {
          context.report({
            node,
            messageId: "nonZeroApi",
            data: { path: node.value },
          });
        }
      },
      TemplateLiteral(node) {
        // Check the static parts of template literals
        for (const quasi of node.quasis) {
          const value = quasi.value.raw;
          if (containsNonZeroApiPath(value)) {
            context.report({
              node,
              messageId: "nonZeroApi",
              data: { path: value },
            });
            return;
          }
        }
      },
    };
  },
});
