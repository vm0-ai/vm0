/**
 * Shared card palette used across Insights and Usage pages.
 * Each card picks an accent + soft background tint to create the
 * brand's color-led narrative without overwhelming the data.
 */
export interface CardPalette {
  bg: string;
  accent: string;
}

const PALETTE: readonly CardPalette[] = [
  { bg: "bg-[#EFC184]/20", accent: "#D4956A" },
  { bg: "bg-[#F3B8B1]/20", accent: "#E24B6A" },
  { bg: "bg-[#E1C43C]/15", accent: "#E1C43C" },
  { bg: "bg-gray-50", accent: "#98928B" },
  { bg: "bg-[#EC70A5]/15", accent: "#EC70A5" },
  { bg: "bg-[#358A8E]/15", accent: "#358A8E" },
  { bg: "bg-[#98928B]/15", accent: "#98928B" },
];

export function getCardPalette(colorIndex: number): CardPalette {
  return PALETTE[((colorIndex % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}
