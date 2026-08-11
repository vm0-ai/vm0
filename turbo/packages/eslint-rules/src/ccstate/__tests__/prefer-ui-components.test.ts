import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/prefer-ui-components.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("prefer-ui-components", rule, {
  valid: [
    // Structural click surfaces carry no component-owned class.
    {
      code: `
        const row = (
          <button type="button" className="flex w-full flex-col text-left">
            {label}
          </button>
        );
      `,
    },
    // Already migrated.
    {
      code: `
        const action = <Button variant="quiet" size="icon-sm">{icon}</Button>;
      `,
    },
    // A hidden file input is not a form field.
    {
      code: `<input type="file" className="hidden" onChange={onPick} />`,
    },
    // Other elements are out of scope even when they share a class.
    {
      code: `<div className="hover:bg-state-hover">{children}</div>`,
    },
    // A list row / menu item is not a Button — it only uses the state token.
    {
      code: `
        const item = (
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-state-hover">
            {label}
          </button>
        );
      `,
    },
    // A card surface with a hover state is not a Button either.
    {
      code: `
        const card = (
          <button className="zero-card flex flex-col p-4 text-left hover:bg-state-hover">
            {body}
          </button>
        );
      `,
    },
  ],
  invalid: [
    {
      code: `
        const action = (
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover"
          >
            {icon}
          </button>
        );
      `,
      errors: [{ messageId: "preferUiComponent" }],
    },
    {
      code: `
        const cta = (
          <button className="h-9 rounded-lg bg-primary px-4 text-primary-foreground">
            {label}
          </button>
        );
      `,
      errors: [{ messageId: "preferUiComponent" }],
    },
    // `cn(...)` hides the classes behind a call; the rule reads the source text.
    {
      code: `
        const toggle = (
          <button className={cn("h-8 w-8 rounded-md", open && "hover:bg-state-hover")}>
            {icon}
          </button>
        );
      `,
      errors: [{ messageId: "preferUiComponent" }],
    },
    // The hardcoded brand hex bypasses the primary token as well.
    {
      code: `
        const cta = (
          <button className="h-9 rounded-[10px] bg-[#ed4e01] px-4 text-white">
            {label}
          </button>
        );
      `,
      errors: [{ messageId: "preferUiComponent" }],
    },
    {
      code: `
        const field = (
          <textarea className="rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2" />
        );
      `,
      errors: [{ messageId: "preferUiComponent" }],
    },
  ],
});
