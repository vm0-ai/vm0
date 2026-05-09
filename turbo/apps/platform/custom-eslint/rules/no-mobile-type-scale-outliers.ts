/**
 * ESLint rule: no-mobile-type-scale-outliers
 *
 * Mobile UI in this app uses a two-size body type scale and a single
 * mobile control height for inputs / selects / dropdown menus:
 *
 *   title         text-[16px]
 *   description   text-[14px]
 *   form-input    h-9 desktop · h-12 mobile (baked into Input/SelectTrigger)
 *
 * This rule catches the historical outliers that crept in before the
 * baseline was unified — `text-[15px]`, `text-[17px]`, `max-md:h-10`,
 * `max-md:h-11` — so they don't sneak back into new code. If you really
 * need a different size for a one-off CTA, button, or chrome element,
 * disable this rule for that line with an inline comment.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

// `max-md:h-11` is intentionally allowed — it's the iOS HIG 44pt minimum
// touch target for primary CTAs (buttons, FABs). Inputs / Selects / dropdown
// items inherit `h-12` from the base primitives, which still wins via
// tailwind-merge if a callsite layers `max-md:h-11` over them. The rule
// only stops `max-md:h-10` (the odd-one-out) and the off-scale text sizes.
const FORBIDDEN: { token: string; suggestion: string }[] = [
  { token: "text-[15px]", suggestion: "text-[14px] or text-[16px]" },
  { token: "text-[17px]", suggestion: "text-[16px]" },
  { token: "max-md:h-10", suggestion: "h-9 (desktop) / h-11 (CTA) / inherit baseline (input)" },
  { token: "max-md:text-[15px]", suggestion: "max-md:text-[14px]" },
  { token: "max-md:text-[17px]", suggestion: "max-md:text-[16px]" },
];

function findHits(value: string): { token: string; suggestion: string }[] {
  const hits: { token: string; suggestion: string }[] = [];
  for (const entry of FORBIDDEN) {
    if (value.includes(entry.token)) {
      hits.push(entry);
    }
  }
  return hits;
}

export default createRule({
  name: "no-mobile-type-scale-outliers",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow off-scale Tailwind classes (text-[15/17], max-md:h-10/11) outside the unified mobile type/control scale",
    },
    schema: [],
    messages: {
      outlier:
        'Off-scale Tailwind class "{{token}}" — use {{suggestion}} instead, or rely on the Input / SelectTrigger / DropdownMenuItem baseline (h-12 + text-[16px] on mobile).',
    },
  },
  create(context) {
    function reportHits(
      node: TSESTree.Node,
      value: string,
    ) {
      for (const hit of findHits(value)) {
        context.report({
          node,
          messageId: "outlier",
          data: { token: hit.token, suggestion: hit.suggestion },
        });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        reportHits(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          reportHits(node, quasi.value.raw);
        }
      },
      JSXAttribute(node) {
        if (
          node.value?.type === AST_NODE_TYPES.Literal &&
          typeof node.value.value === "string"
        ) {
          reportHits(node.value, node.value.value);
        }
      },
    };
  },
});
