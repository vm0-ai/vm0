/**
 * ESLint rule: no-get-by-role-name
 *
 * Warns when *ByRole queries use the `name` option for roles whose accessible
 * name comes from subtree text content (button, link, menuitem, tab, …).
 *
 * In happy-dom, `getByRole("button", { name: /text/ })` must compute the ARIA
 * accessible name for every matching element, traversing each element's entire
 * subtree. With 20+ buttons in a rendered page this costs ~300–900ms per call
 * — a 100–900× slowdown compared to text-content alternatives.
 *
 * Bad:
 *   screen.getByRole("button", { name: /Add member/i })     // ~333ms
 *   within(dialog).getByRole("link", { name: "Cancel" })    // still slow
 *
 * Good — use text content directly:
 *   screen.getByText("Add member")
 *   screen.getAllByRole("button").find(el => /Add member/i.test(el.textContent ?? ""))
 *
 * Exception — roles that have few instances or whose names come from labels
 * (heading, dialog, combobox, textbox, checkbox) are not flagged because they
 * either rarely have many DOM instances or are better queried via getByLabelText.
 */

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

/**
 * Roles whose accessible name is derived from subtree text content.
 * These are the roles where *ByRole(role, { name }) is expensive because
 * the library must walk the subtree of every matching element.
 *
 * Not included: roles with few instances per page (heading, dialog, alert),
 * or roles whose name comes from associated label elements (checkbox, radio,
 * textbox, combobox) — those should use getByLabelText instead.
 */
const TEXT_CONTENT_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "cell",
  "columnheader",
  "rowheader",
  "gridcell",
]);

const BY_ROLE_METHODS = new Set([
  "getByRole",
  "getAllByRole",
  "queryByRole",
  "queryAllByRole",
  "findByRole",
  "findAllByRole",
]);

type MessageIds = "avoidRoleWithName";

export default createRule<[], MessageIds>({
  name: "no-get-by-role-name",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Avoid *ByRole(role, { name }) for text-content roles — accessible name computation is O(n×subtree) and causes severe slowdowns in happy-dom",
    },
    schema: [],
    messages: {
      avoidRoleWithName:
        'Avoid *ByRole("{{role}}", { name }) — accessible name computation traverses every matching element\'s subtree and costs ~300ms per call in happy-dom. Use getByText("label") or getAllByRole("{{role}}").find(el => /label/.test(el.textContent ?? "")) instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // Resolve the method name — handles both `screen.getByRole(...)` and
        // `getByRole(...)` and `within(x).getByRole(...)`.
        let methodName: string | undefined;
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier"
        ) {
          methodName = node.callee.property.name;
        } else if (node.callee.type === "Identifier") {
          methodName = node.callee.name;
        }

        if (!methodName || !BY_ROLE_METHODS.has(methodName)) {
          return;
        }

        // First argument must be a string literal role name.
        const roleArg = node.arguments[0];
        if (
          !roleArg ||
          roleArg.type !== "Literal" ||
          typeof roleArg.value !== "string"
        ) {
          return;
        }

        const role = roleArg.value;
        if (!TEXT_CONTENT_ROLES.has(role)) {
          return;
        }

        // Second argument must be an options object containing a `name` key.
        const optionsArg = node.arguments[1];
        if (!optionsArg || optionsArg.type !== "ObjectExpression") {
          return;
        }

        const hasNameProp = optionsArg.properties.some(
          (prop) =>
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            prop.key.name === "name",
        );

        if (!hasNameProp) {
          return;
        }

        context.report({
          node,
          messageId: "avoidRoleWithName",
          data: { role },
        });
      },
    };
  },
});
