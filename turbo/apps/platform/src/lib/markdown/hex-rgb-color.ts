const HEX_RGB_COLOR_PATTERN = /#[\dA-Fa-f]{6}/gu;
const TOKEN_CHARACTER_PATTERN = /[\dA-Za-z_]/u;

interface HexRgbColorMatch {
  readonly color: string;
  readonly start: number;
  readonly end: number;
}

export function findHexRgbColors(text: string): readonly HexRgbColorMatch[] {
  const colors: HexRgbColorMatch[] = [];
  for (const match of text.matchAll(HEX_RGB_COLOR_PATTERN)) {
    const color = match[0];
    const start = match.index;
    const end = start + color.length;
    const previousCharacter = text[start - 1];
    const nextCharacter = text[end];
    if (
      (previousCharacter !== undefined &&
        TOKEN_CHARACTER_PATTERN.test(previousCharacter)) ||
      (nextCharacter !== undefined &&
        TOKEN_CHARACTER_PATTERN.test(nextCharacter))
    ) {
      continue;
    }
    colors.push({ color, start, end });
  }
  return colors;
}
