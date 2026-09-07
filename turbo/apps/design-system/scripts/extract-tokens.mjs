/**
 * Reads every design token the product actually ships and writes one manifest
 * the catalogue renders from.
 *
 * The catalogue never restates a token by hand. `packages/ui/styles/globals.css`
 * is the base layer and `apps/platform/.../css/index.css` is the layer the
 * product loads on top of it, so a token added to either file appears in the
 * catalogue on the next build with no edit here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBlocks } from "./lib/css-parse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const turboRoot = resolve(here, "../../..");
const outFile = resolve(here, "../src/generated/tokens.json");

const SOURCES = [
  {
    id: "ui",
    label: "@okouai/ui",
    path: resolve(turboRoot, "packages/ui/src/styles/globals.css"),
    note: "The base layer. Every surface, ramp stop and interaction state starts here.",
  },
  {
    id: "platform",
    label: "@okouai/platform",
    path: resolve(turboRoot, "apps/platform/src/views/css/index.css"),
    note: "Loaded on top of the base layer by the product. What it redeclares, it wins.",
  },
];

/**
 * Sections are matched in order, so a specific rule can precede a general one.
 * Anything unmatched lands in `other`, which is deliberately visible in the
 * catalogue: an unclassified token is a token nobody has placed yet.
 */
const SECTIONS = [
  {
    id: "brand",
    title: "Brand scale",
    blurb:
      "Amber, adopted stop-for-stop from the published palette. The brand stop is 300, not the 700 the pre-rebrand orange used, and it is the same fill in both themes.",
    match: (n) => {
      return /^--primary-\d/.test(n);
    },
  },
  {
    id: "neutral",
    title: "Neutral ramp",
    blurb:
      "Anchored on Linen (#FAF5F3) and Ink (#242321). Contrast, not equal numeric spacing, sets the text end: 600 clears 3:1, 700 clears 4.5:1.",
    match: (n) => {
      return /^--gray-\d/.test(n);
    },
  },
  {
    id: "surface",
    title: "Surfaces & text",
    blurb:
      "The semantic layer components actually reference. Everything here resolves into the two ramps above.",
    match: (n) => {
      return /^--(background|foreground|card|popover|primary|secondary|muted|accent|border|input|ring|divider|sidebar|overlay|white|black|on-filled|semantic-foreground|tooltip-bg)(-|$)/.test(
        n,
      );
    },
  },
  {
    id: "status",
    title: "Status & brand text",
    blurb:
      "Coral carries both destructive and interrupt. Interrupting a run is not destruction, so it sits two stops lighter on the same ramp.",
    match: (n) => {
      return /^--(destructive|interrupt|brand-subtle|brand-text)(-|$)/.test(n);
    },
  },
  {
    id: "state",
    title: "Interaction states",
    blurb:
      "One ladder for every hover, selected and pressed background. Translucent layers for elements with no fill of their own; pre-mixed pairs for elements that already carry one.",
    match: (n) => {
      return n.startsWith("--state-");
    },
  },
  {
    id: "segment",
    title: "Segment control",
    blurb:
      "The selected segment needs its own pair: in dark, --card sits below the track, so a card-filled segment reads recessed instead of selected.",
    match: (n) => {
      return /^--(segment-|shadow-segment)/.test(n);
    },
  },
  {
    id: "dataviz",
    title: "Data colours",
    blurb:
      "Credit and usage breakdowns. These are literal hexes on purpose — a chart series must stay separable, which the neutral ramp cannot guarantee.",
    match: (n) => {
      return /^--color-(credit|usage-kind)-/.test(n);
    },
  },
  {
    id: "type",
    title: "Typography",
    blurb:
      "Geist and Geist Mono, set by the platform layer. The base layer still names Noto Sans; the platform override is what the product renders.",
    match: (n) => {
      return /^--(font-family|font-size|line-height|text-|tracking-|leading-)/.test(
        n,
      );
    },
  },
  {
    id: "shape",
    title: "Shape & focus",
    blurb: "Radius ladder and the input focus ring.",
    match: (n) => {
      return /^--(radius|input-border-radius|input-focus)/.test(n);
    },
  },
  {
    id: "icon",
    title: "Icon system",
    blurb:
      "Lucide emits a 2px stroke when nothing overrides it. The base layer normalises that to 1.5 for every icon that has not opted out.",
    match: (n) => {
      return n.startsWith("--icon-");
    },
  },
  {
    id: "chrome",
    title: "App chrome",
    blurb:
      "Tokens the product surface adds on top: nav rail, workspace card, composer, safe areas.",
    match: (n) => {
      return /^--(okou-|sa[blrt]$)/.test(n);
    },
  },
  {
    id: "alias",
    title: "Tailwind aliases",
    blurb:
      "@theme entries that expose the tokens above to Tailwind as utility classes. These carry no value of their own.",
    match: (n) => {
      return n.startsWith("--color-");
    },
  },
  {
    id: "other",
    title: "Unclassified",
    blurb: "",
    match: () => {
      return true;
    },
  },
];

const COLOR_THEME_ORDER = [
  "golden-hour",
  "citrus-spark",
  "limelight",
  "deep-lagoon",
  "daydream",
  "cotton-sky",
  "berry-blush",
  "blue-horizon",
];

function scopeOf(selector) {
  const isDark = /\.dark\b|\[data-theme="dark"\]/.test(selector);
  const isColorThemeOverride = /\[data-gradient-color-themes\]/.test(selector);
  const namedTheme = /\[data-color-theme="([a-z-]+)"\]/.exec(selector);

  if (namedTheme && !isColorThemeOverride) {
    return { kind: "namedTheme", theme: namedTheme[1] };
  }
  if (isColorThemeOverride) {
    return { kind: "colorTheme", theme: isDark ? "dark" : "light" };
  }
  if (selector === "@theme") return { kind: "alias" };
  if (isDark) return { kind: "theme", theme: "dark" };
  if (/^:root\b/.test(selector) || selector === "*") {
    return { kind: "theme", theme: "light" };
  }
  return null;
}

/**
 * Drops comments the catalogue would only repeat: a bare hex is already the
 * swatch label, and `gray-200` beside `--border: var(--gray-200)` says nothing.
 */
function usefulComment(comment) {
  if (!comment) return null;
  const text = comment.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return null;
  if (/^[a-z0-9-]+( - .*)?$/i.test(text) && text.length < 24) return null;
  // A prose comment that ends with the stop's own hex repeats the swatch label.
  return text.replace(/\n#[0-9a-f]{3,8}$/i, "");
}

function isColorValue(value) {
  return (
    /^#[0-9a-f]{3,8}$/i.test(value) ||
    /^-?[\d.]+ [\d.]+% [\d.]+%$/.test(value) ||
    /^(hsl|rgb|oklch|color-mix)\(/.test(value)
  );
}

/** `38.8 100% 50%` -> `#ffa500`. Returns null for anything else. */
function hslTripleToHex(value) {
  const m = /^(-?[\d.]+) ([\d.]+)% ([\d.]+)%$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;

  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rgb = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];

  return `#${rgb
    .map((c) => {
      return Math.round(c * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`.toUpperCase();
}

/** Follows `var(--x)` chains within one theme, falling back to the light value. */
function resolveHex(value, themeMap, fallbackMap, seen = new Set()) {
  if (!value) return null;
  const direct = /^#[0-9a-f]{3,8}$/i.test(value) ? value.toUpperCase() : null;
  if (direct) return direct;

  const triple = hslTripleToHex(value);
  if (triple) return triple;

  const varRef = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
  if (!varRef) return null;
  const next = varRef[1];
  if (seen.has(next)) return null;
  seen.add(next);
  return resolveHex(
    themeMap.get(next) ?? fallbackMap.get(next),
    themeMap,
    fallbackMap,
    seen,
  );
}

const light = new Map();
const dark = new Map();
const alias = new Map();
const comments = new Map();
const origin = new Map();
const colorThemeLight = new Map();
const colorThemeDark = new Map();
const namedThemes = new Map();
const sourceStats = [];

for (const source of SOURCES) {
  const src = readFileSync(source.path, "utf8");
  const blocks = parseBlocks(src);
  let count = 0;

  for (const block of blocks) {
    const scope = scopeOf(block.selector);
    if (!scope) continue;

    for (const decl of block.decls) {
      count += 1;
      const note = usefulComment(decl.comment);
      if (note && !comments.has(decl.prop)) comments.set(decl.prop, note);
      // The platform layer loads second, so it overwrites by design.
      origin.set(decl.prop, source.id);

      if (scope.kind === "alias") alias.set(decl.prop, decl.value);
      else if (scope.kind === "theme" && scope.theme === "light")
        light.set(decl.prop, decl.value);
      else if (scope.kind === "theme") dark.set(decl.prop, decl.value);
      else if (scope.kind === "colorTheme" && scope.theme === "light")
        colorThemeLight.set(decl.prop, decl.value);
      else if (scope.kind === "colorTheme")
        colorThemeDark.set(decl.prop, decl.value);
      else if (scope.kind === "namedTheme") {
        const entry = namedThemes.get(scope.theme) ?? {};
        entry[decl.prop] = decl.value;
        namedThemes.set(scope.theme, entry);
      }
    }
  }

  sourceStats.push({
    id: source.id,
    label: source.label,
    note: source.note,
    path: relative(turboRoot, source.path),
    declarations: count,
  });
}

const allNames = new Set([...light.keys(), ...dark.keys(), ...alias.keys()]);

/** Scale stops sort by their number, so `--gray-50` precedes `--gray-100`. */
function compareTokenNames(a, b) {
  const stop = /^(.*?)-(\d+)$/;
  const ma = stop.exec(a);
  const mb = stop.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a.localeCompare(b);
}

const tokens = [...allNames].sort(compareTokenNames).map((name) => {
  const lightValue = light.get(name) ?? alias.get(name) ?? null;
  const darkValue = dark.get(name) ?? lightValue;
  const lightHex = resolveHex(lightValue, light, alias);
  const darkHex = resolveHex(darkValue, dark, light);

  return {
    name,
    light: lightValue,
    dark: darkValue,
    lightHex,
    darkHex,
    themed: dark.has(name) && dark.get(name) !== light.get(name),
    kind:
      lightHex || (lightValue && isColorValue(lightValue)) ? "color" : "value",
    comment: comments.get(name) ?? null,
    source: origin.get(name) ?? "ui",
    aliasOf: alias.has(name) ? alias.get(name) : null,
  };
});

const sections = SECTIONS.map((section) => {
  return {
    id: section.id,
    title: section.title,
    blurb: section.blurb,
    tokens: [],
  };
});

for (const token of tokens) {
  const section = SECTIONS.find((s) => {
    return s.match(token.name);
  });
  sections
    .find((s) => {
      return s.id === section.id;
    })
    .tokens.push(token);
}

const colorThemes = COLOR_THEME_ORDER.filter((id) => {
  return namedThemes.has(id);
}).map((id) => {
  const entry = namedThemes.get(id);
  return {
    id,
    label: id.replace(/(^|-)([a-z])/g, (_, sep, ch) => {
      return (sep ? " " : "") + ch.toUpperCase();
    }),
    anchor: entry["--okou-color-theme-anchor"] ?? null,
    companion: entry["--okou-color-theme-companion"] ?? null,
    hue: entry["--okou-color-theme-hue"] ?? null,
    ring: entry["--okou-color-theme-ring"] ?? null,
  };
});

const manifest = {
  sources: sourceStats,
  sections: sections.filter((s) => {
    return s.tokens.length > 0;
  }),
  colorThemes,
  colorThemeOverrides: {
    light: [...colorThemeLight.keys()].sort(),
    dark: [...colorThemeDark.keys()].sort(),
  },
  totals: {
    tokens: tokens.length,
    themed: tokens.filter((t) => {
      return t.themed;
    }).length,
    colors: tokens.filter((t) => {
      return t.kind === "color";
    }).length,
  },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(
  `tokens: ${manifest.totals.tokens} (${manifest.totals.colors} colours, ${manifest.totals.themed} theme-aware) across ${manifest.sections.length} sections, ${colorThemes.length} colour themes\n`,
);
