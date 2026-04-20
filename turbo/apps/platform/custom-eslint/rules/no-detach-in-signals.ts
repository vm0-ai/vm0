/**
 * ESLint rule: no-detach-in-signals
 *
 * Disallows calling `detach()` in files under `src/signals/`.
 *
 * `detach()` is designed for the views layer where DOM event callbacks cannot
 * return promises.  In the signals layer, commands should manage async work
 * through `await` and the signal chain — using `detach` there is a misuse
 * that hides lifecycle issues.
 *
 * Good (views layer):
 *   const handleClick = () => {
 *     detach(commandFn(pageSignal), Reason.DomCallback);
 *   };
 *
 * Bad (signals layer):
 *   export const setupPage$ = command(({ set }, signal) => {
 *     detach(set(fetchData$, signal), Reason.Entrance);
 *   });
 *
 * @see .claude/skills/ccstate/SKILL.md § "Scope of detach() usage"
 */

import type { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

export default createRule({
  name: "no-detach-in-signals",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow detach() in signals/ files — use await or signal chain instead. See .claude/skills/ccstate/SKILL.md § 'Scope of detach() usage'",
    },
    schema: [],
    messages: {
      noDetachInSignals:
        "Do not use detach() in signals/. In the signals layer, manage async work with await or the signal chain. detach() is only for DOM event callbacks in the views layer. See .claude/skills/ccstate/SKILL.md § 'Scope of detach() usage'.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Only apply to files under src/signals/ (excluding __tests__)
    if (
      !filename.includes("/src/signals/") ||
      filename.includes("/__tests__/")
    ) {
      return {};
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "detach"
        ) {
          context.report({
            node,
            messageId: "noDetachInSignals",
          });
        }
      },
    };
  },
});
