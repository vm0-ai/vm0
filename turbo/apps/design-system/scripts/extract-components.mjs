/**
 * Reads the component surface of `@okouai/ui` straight from its source.
 *
 * Two things come out of this: the list of exported components, which the
 * coverage gate compares against the demos in the catalogue, and the `cva`
 * variant maps, which the catalogue renders exhaustively. A variant added to
 * `button.tsx` therefore shows up as a new swatch row without anyone editing
 * the catalogue -- which is the only version of "keep it in sync" that holds.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { matchBrace } from "./lib/css-parse.mjs";
import { emit } from "./lib/emit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, "../../../packages/ui/src");
const outFile = resolve(here, "../src/generated/components.json");

const indexSource = readFileSync(resolve(uiRoot, "index.ts"), "utf8");

/** Every identifier `index.ts` re-exports, mapped to the file it came from. */
function readExports(src) {
  /** @type {{ name: string, module: string, isType: boolean }[]} */
  const entries = [];
  const re = /export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const module = match[2];
    for (const raw of match[1].split(",")) {
      const name = raw.trim();
      if (!name) continue;
      const isType = name.startsWith("type ");
      entries.push({ name: name.replace(/^type\s+/, ""), module, isType });
    }
  }
  return entries;
}

/** Pulls the `variants: { ... }` map out of every `cva(...)` call in a file. */
function readVariants(src) {
  /** @type {Record<string, string[]>} */
  const variants = {};
  let cursor = 0;

  for (;;) {
    const call = src.indexOf("cva(", cursor);
    if (call === -1) break;
    const open = src.indexOf("(", call);
    const close = matchBrace(src, open);
    if (close === -1) break;
    cursor = close;

    // Comments are stripped first: `// action: toolbar icons` inside the
    // variant map reads exactly like a variant key otherwise.
    const body = stripComments(src.slice(open + 1, close));
    const varsAt = body.indexOf("variants:");
    if (varsAt === -1) continue;
    const varsOpen = body.indexOf("{", varsAt);
    const varsClose = matchBrace(body, varsOpen);
    if (varsClose === -1) continue;

    const varsBody = body.slice(varsOpen + 1, varsClose);
    for (const [group, values] of readObjectKeys(varsBody)) {
      variants[group] = values;
    }
  }

  return variants;
}

/** Removes `//` and block comments while leaving string literals intact. */
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        out += src[i];
        if (src[i] === "\\") {
          out += src[i + 1] ?? "";
          i += 1;
        }
        i += 1;
      }
      out += quote;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end - 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Top-level `key: { ...subKeys }` pairs of an object body, one nesting deep. */
function readObjectKeys(body) {
  /** @type {[string, string[]][]} */
  const out = [];
  let i = 0;
  while (i < body.length) {
    const keyMatch = /(?:^|[,{\s])\s*("?)([A-Za-z][\w-]*)\1\s*:\s*\{/.exec(
      body.slice(i),
    );
    if (!keyMatch) break;
    const at = i + keyMatch.index + keyMatch[0].length - 1;
    const end = matchBrace(body, at);
    if (end === -1) break;
    out.push([keyMatch[2], readLeafKeys(body.slice(at + 1, end))]);
    i = end;
  }
  return out;
}

function readLeafKeys(body) {
  /** @type {string[]} */
  const keys = [];
  let depth = 0;
  const re = /(?:^|[,\s])("?)([A-Za-z][\w-]*)\1\s*:/g;
  // Only depth-0 keys are variant values; anything deeper is inside a class list.
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < body.length && body[i] !== quote)
        i += body[i] === "\\" ? 2 : 1;
    } else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(body);
      if (m && m.index === i) {
        keys.push(m[2]);
        i = re.lastIndex - 1;
      }
    }
  }
  return keys;
}

/** The block comment above the first `cva(` or type declaration, if any. */
function readDoc(src) {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(src);
  if (!match) return null;
  const text = match[1]
    .split("\n")
    .map((l) => {
      return l.replace(/^\s*\*?\s?/, "").trimEnd();
    })
    .join("\n")
    .trim();
  return text || null;
}

const files = readdirSync(resolve(uiRoot, "components/ui"))
  .filter((f) => {
    return f.endsWith(".tsx");
  })
  .sort();

const exportEntries = readExports(indexSource);

const components = files.map((file) => {
  const src = readFileSync(resolve(uiRoot, "components/ui", file), "utf8");
  const module = `./components/ui/${file.replace(/\.tsx$/, "")}`;
  const exports = exportEntries.filter((e) => {
    return e.module === module;
  });

  return {
    file,
    id: file.replace(/\.tsx$/, ""),
    module,
    exports: exports
      .filter((e) => {
        return !e.isType;
      })
      .map((e) => {
        return e.name;
      }),
    types: exports
      .filter((e) => {
        return e.isType;
      })
      .map((e) => {
        return e.name;
      }),
    variants: readVariants(src),
    doc: readDoc(src),
    lines: src.split("\n").length,
    usesBaseUi: /@base-ui\/react/.test(src),
  };
});

const manifest = {
  components,
  totals: {
    files: components.length,
    exported: components.filter((c) => {
      return c.exports.length > 0;
    }).length,
    withVariants: components.filter((c) => {
      return Object.keys(c.variants).length > 0;
    }).length,
  },
};

emit(
  outFile,
  manifest,
  `components: ${manifest.totals.files} files, ${manifest.totals.exported} exported, ${manifest.totals.withVariants} with cva variants`,
);
