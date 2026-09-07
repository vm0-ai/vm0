import type { ClerkProviderProps } from "@clerk/react";

type Appearance = NonNullable<ClerkProviderProps["appearance"]>;

/**
 * Hosted auth inherits only Clerk's cascade layer and semantic design tokens.
 * Component-level appearance owns the visual rules, so unrelated Clerk
 * surfaces cannot inherit authentication-specific element overrides.
 */
export function getAuthV1ProviderAppearance(): Appearance {
  return {
    cssLayerName: "clerk",
    variables: clerkVariables(),
  };
}

function clerkVariables(): Record<string, string> {
  return {
    // Clerk's sign-up legal links consume this public variable and do not
    // expose a dedicated appearance element. Filled controls retain the
    // primary fill through their public component-level element classes.
    colorPrimary: "hsl(var(--brand-text))",
    colorBackground: "hsl(var(--card))",
    colorNeutral: "hsl(var(--foreground))",
    colorForeground: "hsl(var(--foreground))",
    colorMutedForeground: "hsl(var(--muted-foreground))",
    colorPrimaryForeground: "hsl(var(--primary-foreground))",
    colorMuted: "hsl(var(--muted))",
    colorInput: "hsl(var(--input))",
    colorInputForeground: "hsl(var(--foreground))",
    colorBorder: "hsl(var(--border))",
    colorRing: "hsl(var(--ring))",
    colorDanger: "hsl(var(--destructive))",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--text-sm)",
    borderRadius: "var(--radius-lg)",
  };
}
