import type { ClerkProviderProps } from "@clerk/react";

type Appearance = NonNullable<ClerkProviderProps["appearance"]>;

/**
 * Hosted auth inherits only Clerk's cascade layer and semantic design tokens.
 * Component-level appearance owns the visual rules, so unrelated Clerk
 * surfaces cannot inherit authentication-specific element overrides.
 */
export function getAuthV1ProviderAppearance(
  theme: "light" | "dark",
): Appearance {
  return {
    cssLayerName: "clerk",
    variables: clerkVariables(theme),
  };
}

function clerkVariables(theme: "light" | "dark"): Record<string, string> {
  return {
    // Clerk shares the primary color between text links and filled controls.
    // Use the readable brand pair and retain its native control hierarchy.
    colorPrimary: "hsl(var(--brand-text))",
    colorBackground: "hsl(var(--card))",
    // Clerk derives its border scale from this value. Passing our --border
    // token through colorBorder collides with Clerk's local --border variable.
    colorNeutral: "hsl(var(--foreground))",
    colorForeground: "hsl(var(--foreground))",
    colorMutedForeground: "hsl(var(--muted-foreground))",
    colorPrimaryForeground:
      theme === "dark"
        ? "hsl(var(--primary-foreground))"
        : "hsl(var(--on-filled))",
    colorMuted: "hsl(var(--muted))",
    colorInput: "hsl(var(--input))",
    colorInputForeground: "hsl(var(--foreground))",
    colorRing: "hsl(var(--ring))",
    colorDanger: "hsl(var(--destructive))",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--text-sm)",
    borderRadius: "var(--radius-lg)",
  };
}
