export const SQL_TEMPLATE_EXPRESSION_BOUNDARY = "\u0000";

type SqlLexicalState =
  | { readonly kind: "block-comment"; readonly depth: number }
  | { readonly kind: "code" }
  | { readonly kind: "dollar-quote"; readonly delimiter: string }
  | { readonly kind: "double-quote" }
  | { readonly kind: "line-comment" }
  | { readonly kind: "single-quote" };

export function sqlCodeMask(source: string): string {
  const mask = source.split("");
  let state: SqlLexicalState = { kind: "code" };
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] === SQL_TEMPLATE_EXPRESSION_BOUNDARY) {
      mask[offset] = SQL_TEMPLATE_EXPRESSION_BOUNDARY;
      offset += 1;
      continue;
    }
    if (state.kind === "code") {
      const pair = source.slice(offset, offset + 2);
      if (pair === "--") {
        mask[offset] = " ";
        mask[offset + 1] = " ";
        state = { kind: "line-comment" };
        offset += 2;
        continue;
      }
      if (pair === "/*") {
        mask[offset] = " ";
        mask[offset + 1] = " ";
        state = { kind: "block-comment", depth: 1 };
        offset += 2;
        continue;
      }
      const character = source[offset];
      if (character === "'") {
        mask[offset] = " ";
        state = { kind: "single-quote" };
        offset += 1;
        continue;
      }
      if (character === '"') {
        mask[offset] = " ";
        state = { kind: "double-quote" };
        offset += 1;
        continue;
      }
      if (character === "$") {
        const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
          source.slice(offset),
        )?.[0];
        if (delimiter !== undefined) {
          for (let index = 0; index < delimiter.length; index += 1) {
            mask[offset + index] = " ";
          }
          state = { kind: "dollar-quote", delimiter };
          offset += delimiter.length;
          continue;
        }
      }
      offset += 1;
      continue;
    }

    const character = source[offset];
    mask[offset] = character === "\n" ? "\n" : " ";
    if (state.kind === "line-comment") {
      if (character === "\n") {
        state = { kind: "code" };
      }
      offset += 1;
      continue;
    }
    if (state.kind === "block-comment") {
      const pair = source.slice(offset, offset + 2);
      if (pair === "/*") {
        mask[offset + 1] = " ";
        state = { kind: "block-comment", depth: state.depth + 1 };
        offset += 2;
        continue;
      }
      if (pair === "*/") {
        mask[offset + 1] = " ";
        const depth: number = state.depth - 1;
        state =
          depth === 0 ? { kind: "code" } : { kind: "block-comment", depth };
        offset += 2;
        continue;
      }
      offset += 1;
      continue;
    }
    if (state.kind === "dollar-quote") {
      if (source.startsWith(state.delimiter, offset)) {
        for (let index = 0; index < state.delimiter.length; index += 1) {
          mask[offset + index] = " ";
        }
        offset += state.delimiter.length;
        state = { kind: "code" };
      } else {
        offset += 1;
      }
      continue;
    }

    const quote = state.kind === "single-quote" ? "'" : '"';
    if (character !== quote) {
      offset += 1;
      continue;
    }
    if (source[offset + 1] === quote) {
      mask[offset + 1] = " ";
      offset += 2;
      continue;
    }
    let backslashes = 0;
    for (
      let index = offset - 1;
      index >= 0 && source[index] === "\\";
      index -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      state = { kind: "code" };
    }
    offset += 1;
  }
  return mask.join("");
}
