/**
 * A minimal CSS scanner built for one job: reading custom-property
 * declarations out of the design-system stylesheets together with the comments
 * that document them.
 *
 * A general CSS parser would drop the comments, and the comments are half the
 * value here -- `globals.css` records the contrast reasoning for nearly every
 * stop, and that reasoning is what a reviewer needs beside the swatch.
 */

/**
 * @typedef {{ prop: string, value: string, comment: string | null, line: number }} Decl
 * @typedef {{ selector: string, decls: Decl[], line: number }} Block
 */

/**
 * @param {string} src
 * @returns {Block[]}
 */
export function parseBlocks(src) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {Block[]} */
  const stack = [];

  let buffer = "";
  let pendingComment = null;
  let lastDeclEndLine = -1;
  let line = 1;

  const flushDecl = (raw, endLine) => {
    const text = raw.trim();
    if (!text.startsWith("--")) return;
    const colon = text.indexOf(":");
    if (colon === -1) return;
    const block = stack[stack.length - 1];
    if (!block) return;
    block.decls.push({
      prop: text.slice(0, colon).trim(),
      value: normalizeValue(text.slice(colon + 1)),
      comment: pendingComment,
      line: endLine,
    });
    pendingComment = null;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      const body = src.slice(i + 2, end === -1 ? src.length : end);
      const startLine = line;
      for (let j = i; j < stop; j += 1) if (src[j] === "\n") line += 1;

      const text = body
        .split("\n")
        .map((l) => {
          return l.replace(/^\s*\*?\s?/, "").trimEnd();
        })
        // `=====` rules are section banners, not prose.
        .filter((l) => {
          return !/^=+$/.test(l.trim());
        })
        .join("\n")
        .trim();

      // A comment on the same line as the declaration that just closed is
      // documenting that declaration, not the one that follows it.
      if (startLine === lastDeclEndLine) {
        const block = stack[stack.length - 1];
        const last = block?.decls[block.decls.length - 1];
        if (last) last.comment = joinComment(last.comment, text);
      } else if (text) {
        // The nearest comment wins: a section banner two comments up is not
        // documentation for the declaration that happens to follow it.
        pendingComment = text;
      }
      i = stop - 1;
      continue;
    }

    if (ch === "\n") line += 1;

    if (ch === "{") {
      const selector = buffer.trim().replace(/\s+/g, " ");
      const block = { selector, decls: [], line };
      blocks.push(block);
      stack.push(block);
      buffer = "";
      pendingComment = null;
      continue;
    }

    if (ch === "}") {
      flushDecl(buffer, line);
      buffer = "";
      stack.pop();
      pendingComment = null;
      continue;
    }

    if (ch === ";") {
      flushDecl(buffer, line);
      buffer = "";
      lastDeclEndLine = line;
      continue;
    }

    buffer += ch;
  }

  return blocks;
}

function joinComment(existing, next) {
  if (!next) return existing;
  return existing ? `${existing}\n${next}` : next;
}

function normalizeValue(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Matches the balanced closing brace/paren for the opener at `open`.
 *
 * @param {string} src
 * @param {number} open index of the opening character
 * @returns {number} index of the matching closer, or -1
 */
export function matchBrace(src, open) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const closer = pairs[src[open]];
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (ch in pairs) depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === quote) return i;
  }
  return src.length;
}
