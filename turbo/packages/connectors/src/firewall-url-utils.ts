const ASCII_CONTROL_MAX = 0x20;
const ASCII_DELETE = 0x7f;
const UNICODE_HIGH_SURROGATE_MIN = 0xd800;
const UNICODE_HIGH_SURROGATE_MAX = 0xdbff;
const UNICODE_LOW_SURROGATE_MIN = 0xdc00;
const UNICODE_LOW_SURROGATE_MAX = 0xdfff;

export function hasRawWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r" ||
      char === "\f" ||
      char === "\v"
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnsafeUrlCodepoint(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (codeUnit < ASCII_CONTROL_MAX || codeUnit === ASCII_DELETE) {
      return true;
    }
    if (
      UNICODE_HIGH_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_HIGH_SURROGATE_MAX
    ) {
      const nextCodeUnit = value.charCodeAt(i + 1);
      if (
        !(
          UNICODE_LOW_SURROGATE_MIN <= nextCodeUnit &&
          nextCodeUnit <= UNICODE_LOW_SURROGATE_MAX
        )
      ) {
        return true;
      }
      i += 1;
      continue;
    }
    if (
      UNICODE_LOW_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_LOW_SURROGATE_MAX
    ) {
      return true;
    }
  }
  return false;
}
