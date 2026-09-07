import { buttonVariants, cardClassName, inputClassName } from "@okouai/ui";
import { expect, test } from "vitest";

import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
} from "../../../lib/static-assets.ts";
import {
  getAuthV1LegacyComponentAppearance,
  getAuthV1SignInAppearance,
} from "../component-appearance.ts";
import { getAuthV1ProviderAppearance } from "../provider-appearance.ts";

const OKOU_AUTH_BRAND = {
  brandName: "Okou",
  homeUrl: "https://app.okou.ai",
} as const;

function elementClasses(
  appearance: ReturnType<typeof getAuthV1SignInAppearance>,
  key: string,
): string {
  const element = (
    appearance.elements as Record<string, unknown> | undefined
  )?.[key];
  if (typeof element !== "string") {
    throw new Error(`Expected ${key} to use Tailwind classes`);
  }
  return element;
}

function elementStyles(
  appearance: ReturnType<typeof getAuthV1SignInAppearance>,
  key: string,
): Record<string, unknown> {
  const element = (
    appearance.elements as Record<string, unknown> | undefined
  )?.[key];
  if (!element || typeof element !== "object") {
    throw new Error(`Expected ${key} to use CSS-in-JS styles`);
  }
  return element as Record<string, unknown>;
}

test("Hosted sign-in uses Clerk's supported Tailwind customization surface", () => {
  const appearance = getAuthV1SignInAppearance("light", OKOU_AUTH_BRAND);

  expect(appearance.theme).toBe("simple");
  expect(appearance.options).toMatchObject({
    elevation: "raised",
    logoImageUrl: expect.stringMatching(/^data:image\/svg\+xml,/u),
    logoLinkUrl: OKOU_AUTH_BRAND.homeUrl,
    logoPlacement: "inside",
    socialButtonsPlacement: "top",
    socialButtonsVariant: "blockButton",
  });
  expect(elementClasses(appearance, "cardBox")).toContain(cardClassName);
  expect(elementClasses(appearance, "formFieldInput")).toContain(
    inputClassName,
  );
  expect(elementClasses(appearance, "formButtonPrimary")).toContain(
    buttonVariants({ size: "default", variant: "default" }),
  );
  expect(elementClasses(appearance, "formButtonPrimary")).toContain(
    "okou-auth-action-text",
  );
  expect(
    elementClasses(appearance, "lastAuthenticationStrategyBadge"),
  ).toContain("okou-auth-badge-text");
  expect(elementStyles(appearance, "logoBox").backgroundImage).toContain(
    platformOkouWordmarkDarkImg,
  );
  expect(elementClasses(appearance, "footerAction__signIn")).toContain(
    "text-brand-text",
  );
  expect(elementClasses(appearance, "footerAction__usePasskey")).toContain(
    "flex",
  );

  const serializedAppearance = JSON.stringify(appearance);
  expect(serializedAppearance).not.toContain("!important");
  expect(serializedAppearance).not.toContain("[class*=");
  expect(serializedAppearance).not.toContain("cl-internal-");
});

test("Hosted sign-in selects the theme-aware Okou logo", () => {
  expect(
    elementStyles(getAuthV1SignInAppearance("dark", OKOU_AUTH_BRAND), "logoBox")
      .backgroundImage,
  ).toContain(platformOkouWordmarkLightImg);
});

test("The sign-in provider exposes only design tokens below Tailwind utilities", () => {
  const appearance = getAuthV1ProviderAppearance();

  expect(appearance.cssLayerName).toBe("clerk");
  expect(appearance).not.toHaveProperty("elements");
  expect(appearance.variables).toMatchObject({
    borderRadius: "var(--radius-lg)",
    colorBackground: "hsl(var(--card))",
    colorPrimary: "hsl(var(--primary))",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--text-sm)",
  });
});

test("Sign-up remains on the legacy appearance during the sign-in migration", () => {
  expect(
    getAuthV1LegacyComponentAppearance("light", "Okou").options?.logoPlacement,
  ).toBe("none");
});
