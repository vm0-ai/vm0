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
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noFireEvent" | "noDispatchEvent";

export default createRule<[], MessageIds>({
  name: "prefer-user-event",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce userEvent over fireEvent and dispatchEvent in tests",
    },
    schema: [],
    messages: {
      noFireEvent:
        "Do not import fireEvent from @testing-library/react. Use userEvent from @testing-library/user-event instead.",
      noDispatchEvent:
        "Do not call .dispatchEvent() directly. Use userEvent from @testing-library/user-event instead.",
    },
  },
  defaultOptions: [],
  create(context) {
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
      "CallExpression[callee.property.name='dispatchEvent']"(node) {
        context.report({ node, messageId: "noDispatchEvent" });
      },
    };
  },
});
