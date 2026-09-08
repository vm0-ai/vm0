/**
 * Types for the two generated manifests, plus the typed re-exports the pages
 * read. Both JSON files are written by `pnpm generate` and are not edited.
 */

import componentsJson from "./generated/components.json";
import tokensJson from "./generated/tokens.json";

export interface TokenEntry {
  name: string;
  light: string | null;
  dark: string | null;
  lightHex: string | null;
  darkHex: string | null;
  themed: boolean;
  kind: string;
  comment: string | null;
  source: string;
  aliasOf: string | null;
}

export interface TokenSection {
  id: string;
  title: string;
  blurb: string;
  tokens: TokenEntry[];
}

interface ColorTheme {
  id: string;
  label: string;
  anchor: string | null;
  companion: string | null;
  hue: string | null;
  ring: string | null;
}

interface TokenManifest {
  sources: {
    id: string;
    label: string;
    note: string;
    path: string;
    declarations: number;
  }[];
  sections: TokenSection[];
  colorThemes: ColorTheme[];
  colorThemeOverrides: { light: string[]; dark: string[] };
  totals: { tokens: number; themed: number; colors: number };
}

export interface ComponentEntry {
  file: string;
  id: string;
  module: string;
  exports: string[];
  types: string[];
  variants: Record<string, string[]>;
  doc: string | null;
  lines: number;
  usesBaseUi: boolean;
}

interface ComponentManifest {
  components: ComponentEntry[];
  totals: { files: number; exported: number; withVariants: number };
}

export const tokens: TokenManifest = tokensJson as TokenManifest;
export const components: ComponentManifest =
  componentsJson as ComponentManifest;

export function section(id: string): TokenSection {
  const found = tokens.sections.find((s) => {
    return s.id === id;
  });
  if (!found) throw new Error(`unknown token section: ${id}`);
  return found;
}
