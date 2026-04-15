/**
 * ESLint rule: prefer-user-event
 *
 * Enforces using @testing-library/user-event instead of raw DOM event
 * dispatch methods in tests. This unifies event triggering behavior and
 * eliminates the need for manual act() wrapping.
 *
 * Detects:
 * 1. Importing `fireEvent` from `@testing-library/react`
 * 2. Calling `.dispatchEvent()` on any object
 *
 * Bad:
 *   import { fireEvent } from "@testing-library/react";
 *   fireEvent.click(button);
 *   element.dispatchEvent(new KeyboardEvent("keydown"));
 *
 * Good:
 *   import userEvent from "@testing-library/user-event";
 *   const user = userEvent.setup();
 *   await user.click(button);
 *   await user.keyboard("{Enter}");
 *
 * Options:
 *   allowedEventTypes: string[] — event constructor names whose dispatchEvent
 *     calls are permitted. Use sparingly for events userEvent cannot simulate
 *     (e.g. "scroll"). The first argument to dispatchEvent must be a `new`
 *     expression whose constructor name matches one of the allowed types.
 *
 * Example config:
 *   "ccstate/prefer-user-event": ["error", { allowedEventTypes: ["scroll"] }]
 */

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noFireEvent" | "noDispatchEvent";

interface Options {
  allowedEventTypes?: string[];
}

export default createRule<[Options?], MessageIds>({
  name: "prefer-user-event",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce userEvent over fireEvent and dispatchEvent in tests",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedEventTypes: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noFireEvent:
        "Do not import fireEvent from @testing-library/react. Use userEvent from @testing-library/user-event instead.",
      noDispatchEvent:
        "Do not call .dispatchEvent() directly. Use userEvent from @testing-library/user-event instead.",
    },
  },
  defaultOptions: [{}],
  create(context) {
    const [options] = context.options;
    const allowedEventTypes = new Set(
      (options?.allowedEventTypes ?? []).map((t) => {
        return t.toLowerCase();
      }),
    );

    function isAllowedDispatchEvent(node: TSESTree.CallExpression): boolean {
      if (allowedEventTypes.size === 0) {
        return false;
      }
      const arg = node.arguments[0];
      if (!arg || arg.type !== "NewExpression") {
        return false;
      }
      const callee = arg.callee;
      if (callee.type !== "Identifier") {
        return false;
      }
      // Event("scroll") and ScrollEvent both match "scroll" in the allowlist.
      // We compare the constructor name itself (e.g. "Event") and also the
      // first string argument when the constructor is the generic "Event".
      const ctorName = callee.name.toLowerCase();

      // Generic Event constructor: check first string argument (the event type)
      if (ctorName === "event" || ctorName === "customevent") {
        const firstArg = arg.arguments[0];
        if (
          firstArg &&
          firstArg.type === "Literal" &&
          typeof firstArg.value === "string" &&
          allowedEventTypes.has(firstArg.value.toLowerCase())
        ) {
          return true;
        }
      }

      // Specific event constructors like ScrollEvent, WheelEvent
      return allowedEventTypes.has(ctorName);
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@testing-library/react") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "fireEvent"
          ) {
            context.report({ node: specifier, messageId: "noFireEvent" });
          }
        }
      },
      "CallExpression[callee.property.name='dispatchEvent']"(
        node: TSESTree.CallExpression,
      ) {
        if (isAllowedDispatchEvent(node)) {
          return;
        }
        context.report({ node, messageId: "noDispatchEvent" });
      },
    };
  },
});
