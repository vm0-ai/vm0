/**
 * Shared accent palette used across Insights and Usage pages.
 * Each card picks one accent color for its eyebrow and inline progress
 * bar fills, so the page reads as a color-led narrative on a uniform
 * card background.
 */
interface CardPalette {
  accent: string;
}

const PALETTE: readonly CardPalette[] = [
  { accent: "#D4956A" },
  { accent: "#E24B6A" },
  { accent: "#E1C43C" },
  { accent: "#98928B" },
  { accent: "#EC70A5" },
  { accent: "#358A8E" },
  { accent: "#98928B" },
];

export function getCardPalette(colorIndex: number): CardPalette {
  return PALETTE[
    ((colorIndex % PALETTE.length) + PALETTE.length) % PALETTE.length
  ]!;
}
