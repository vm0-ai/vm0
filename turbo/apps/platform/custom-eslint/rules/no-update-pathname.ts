/**
 * ESLint rule: no-update-pathname
 *
 * Disallows importing updatePathname$ from route signals.
 * updatePathname$ only pushes browser history without re-running route setup,
 * which causes bugs when used for cross-route navigation (page renders but
 * never initializes). Use navigateInReact$ (in views) or navigate$ (in signals)
 * instead.
 *
 * Good: const navigate = useSet(navigateInReact$)
 * Bad:  const navigate = useSet(updatePathname$)
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noUpdatePathname";

export default createRule<[], MessageIds>({
  name: "no-update-pathname",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow updatePathname$ — use navigateInReact$ (views) or navigate$ (signals) for cross-route navigation",
    },
    schema: [],
    messages: {
      noUpdatePathname:
        "Do not use updatePathname$. It only pushes history without re-running route setup, causing uninitialized pages on cross-route navigation. Use navigateInReact$ (in views) or navigate$ (in signals) instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.replace(/\\/g, "/");

    // Allow in the definition file itself and in tests
    if (
      filename.endsWith("/signals/route.ts") ||
      filename.includes("/__tests__/")
    ) {
      return {};
    }

    return {
      ImportSpecifier(node) {
        if (
          node.imported.type === "Identifier" &&
          node.imported.name === "updatePathname$"
        ) {
          context.report({
            node,
            messageId: "noUpdatePathname",
          });
        }
      },
    };
  },
});
