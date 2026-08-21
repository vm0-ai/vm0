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
 *
 * #28278 moves product routes off the brand namespace one slice at a time, so
 * a neutral path is a violation until its contract has actually moved. The
 * allow list below names the paths that have, which keeps the rule catching a
 * call that skips the branded namespace by accident while letting a migrated
 * slice's callers through.
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "nonZeroApi";

/**
 * Neutral paths whose contract #28278 has already moved off `/api/okou/**`.
 * A slice adds its own paths here in the same commit that moves the contract,
 * so a caller of a migrated route is accepted and every route still waiting for
 * its slice keeps being rejected. Kept as the prefix a caller writes rather
 * than the route template, because a hardcoded path arrives with its
 * parameters already substituted. The migration itself is recorded by
 * `MIGRATED_BRANDED_PATHS` in `apps/api/src/signals/route-entry.ts`.
 */
const MIGRATED_NEUTRAL_API_PATHS: readonly string[] = [
  // #28422
  "/api/artifacts/catalog",
  "/api/logs",
  "/api/push-subscriptions",
  "/api/realtime/token",
  "/api/runs",
  // #28465. The desktop release page and DMG download. Listed as the shared
  // prefix rather than the two paths, because the channel, platform and arch
  // parameters are already substituted by the time the download button builds
  // its URL.
  "/api/desktop/updates",
];

/**
 * True when the `/api/` path inside `value` is one #28278 has migrated. Matches
 * the path itself and anything below it, so a query string or a nested segment
 * still resolves, while a longer sibling like `/api/logs-export` does not.
 */
function isMigratedNeutralApiPath(value: string): boolean {
  const pathStart = value.indexOf("/api/");
  if (pathStart === -1) {
    return false;
  }
  const path = value.slice(pathStart);
  return MIGRATED_NEUTRAL_API_PATHS.some((migrated) => {
    return (
      path === migrated ||
      path.startsWith(`${migrated}/`) ||
      path.startsWith(`${migrated}?`)
    );
  });
}

/**
 * Check if a string contains a non-canonical API path.
 * Matches /api/ followed by anything other than okou/.
 * Ignores external URLs (e.g. https://slack.com/api/...) and the neutral paths
 * #28278 has already migrated.
 */
function containsNonZeroApiPath(value: string): boolean {
  // Skip external URLs — only flag paths starting with /api/ or relative paths
  // that look like our API (not full URLs to third-party services)
  if (/https?:\/\/[^/]+\/api\//.test(value)) {
    return false;
  }
  // Match /api/ that is not followed by the canonical branded namespace.
  if (!/\/api\/(?!okou\/)/.test(value)) {
    return false;
  }
  return !isMigratedNeutralApiPath(value);
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
