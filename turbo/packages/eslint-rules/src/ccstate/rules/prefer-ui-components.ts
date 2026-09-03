/**
 * ESLint rule: prefer-ui-components
 *
 * Catches raw `<button>` / `<input>` / `<textarea>` elements that re-implement a
 * `@okouai/ui` component instead of using it. Hand-rolling them is how the app
 * ended up with three different corner radii on the same icon toolbar.
 *
 * The rule only fires on the two shapes that are unambiguously a component:
 *
 * 1. A fixed square icon box (`h-8 w-8`, `size-8`, ...) that also paints a
 *    hover state — that is `Button variant="quiet" size="icon-*"`.
 * 2. An element painted with a Button-owned fill (`bg-primary` +
 *    `text-primary-foreground`, `bg-destructive`) or the shared field border.
 *
 * It deliberately stays quiet on click surfaces that merely use a state token:
 * cards, list rows, and menu items are not Buttons, and wrapping them in one
 * would add nothing. Those belong to `Card` / `DropdownMenuItem` instead.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

/** A square icon box in the sizes `Button` ships as `size="icon-*"`. */
const ICON_BOX =
  /\b(?:h-(?:6|7|8|9|10) w-(?:6|7|8|9|10)|size-(?:6|7|8|9|10))\b/;
const HOVER_STATE = /\bhover:bg-state-hover\b/;

/**
 * Fills only the shared components are allowed to paint. Each is anchored so a
 * tinted (`bg-primary/10`), prefixed (`hover:bg-destructive`), or extended
 * (`bg-primary-hover`) utility does not count — those are surface accents on an
 * ordinary element, not a Button re-implementation.
 */
const SOLID_PRIMARY = /(?<![\w:/-])bg-primary(?![\w/-])/;
const PRIMARY_INK = /(?<![\w:/-])text-(?:primary-foreground|white)(?![\w/-])/;
const COMPONENT_FILLS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /(?<![\w:/-])bg-destructive(?![\w/-])/, label: "bg-destructive" },
  { pattern: /(?<![\w:/-])bg-\[#ffa500\]/i, label: "a hardcoded brand hex" },
];

/** The shared field recipe owned by `Input` / `Textarea`. */
const FIELD_RECIPE: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /border-\[hsl\(var\(--gray-400\)\)\]/,
    label: "the shared field border",
  },
  { pattern: /focus:ring-primary\/10/, label: "the shared field focus ring" },
];

const REPLACEMENT: Record<string, string> = {
  button: "Button",
  input: "Input",
  textarea: "Textarea",
};

function classText(
  node: TSESTree.JSXOpeningElement,
  getText: (target: TSESTree.Node) => string,
): string {
  let text = "";

  for (const attribute of node.attributes) {
    if (attribute.type !== AST_NODE_TYPES.JSXAttribute) {
      continue;
    }
    if (
      attribute.name.type !== AST_NODE_TYPES.JSXIdentifier ||
      attribute.name.name !== "className"
    ) {
      continue;
    }
    if (!attribute.value) {
      continue;
    }

    // Plain literal, `cn(...)`, or a template literal: the class names appear
    // verbatim in the source either way, so match against the raw text.
    text += ` ${getText(attribute.value)}`;
  }

  return text;
}

function hasAttribute(
  node: TSESTree.JSXOpeningElement,
  name: string,
  value: string,
): boolean {
  return node.attributes.some((attribute) => {
    return (
      attribute.type === AST_NODE_TYPES.JSXAttribute &&
      attribute.name.type === AST_NODE_TYPES.JSXIdentifier &&
      attribute.name.name === name &&
      attribute.value?.type === AST_NODE_TYPES.Literal &&
      attribute.value.value === value
    );
  });
}

function findViolation(tag: string, classes: string): string | null {
  if (tag === "button") {
    if (ICON_BOX.test(classes) && HOVER_STATE.test(classes)) {
      return "a fixed icon box with a hover state";
    }
    if (SOLID_PRIMARY.test(classes) && PRIMARY_INK.test(classes)) {
      return "bg-primary + text-primary-foreground";
    }
    for (const { pattern, label } of COMPONENT_FILLS) {
      if (pattern.test(classes)) {
        return label;
      }
    }
    return null;
  }

  for (const { pattern, label } of FIELD_RECIPE) {
    if (pattern.test(classes)) {
      return label;
    }
  }
  return null;
}

export default createRule({
  name: "prefer-ui-components",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw button/input/textarea elements that re-implement a @okouai/ui component.",
      recommended: true,
    },
    schema: [],
    messages: {
      preferUiComponent:
        "This <{{tag}}> re-implements a shared component ({{marker}}). Use <{{replacement}}> from @okouai/ui so sizing, radius and states stay consistent.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement): void {
        if (node.name.type !== AST_NODE_TYPES.JSXIdentifier) {
          return;
        }

        const tag = node.name.name;
        const replacement = REPLACEMENT[tag];
        if (!replacement) {
          return;
        }

        // A hidden file picker is plumbing, not a field.
        if (hasAttribute(node, "type", "file")) {
          return;
        }

        const marker = findViolation(
          tag,
          classText(node, (target) => {
            return context.sourceCode.getText(target);
          }),
        );
        if (!marker) {
          return;
        }

        context.report({
          node,
          messageId: "preferUiComponent",
          data: { tag, marker, replacement },
        });
      },
    };
  },
});
