/**
 * ESLint rule: no-non-zero-api
 *
 * Enforces that the platform app only calls branded API endpoints.
 * Catches string literals and template literals containing /api/ paths
 * that do not start with the canonical /api/okou/ namespace.
 *
 * Good: "/api/okou/billing/status"
 * Bad: "/api/zero/billing/status"
 * Bad: "/api/billing/status"
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "nonZeroApi";

/**
 * Check if a string contains a non-canonical API path.
 * Matches /api/ followed by anything other than okou/.
 * Ignores external URLs (e.g. https://slack.com/api/...).
 */
function containsNonZeroApiPath(value: string): boolean {
  // Skip external URLs — only flag paths starting with /api/ or relative paths
  // that look like our API (not full URLs to third-party services)
  if (/https?:\/\/[^/]+\/api\//.test(value)) {
    return false;
  }
  // Match /api/ that is not followed by the canonical branded namespace.
  return /\/api\/(?!okou\/)/.test(value);
}

export default createRule<[], MessageIds>({
  name: "no-non-zero-api",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce that the current platform app only calls /api/okou/ endpoints",
    },
    schema: [],
    messages: {
      nonZeroApi:
        "Platform app must only call canonical /api/okou/ endpoints. Found unapproved API path: '{{path}}'. Use an Okou contract + route instead.",
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
