export const PERIODS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000_000) {
    return `${(value / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

export function formatShare(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  return `${value.toFixed(1)}%`;
}

export function formatChange(
  current: number,
  previous: number,
): {
  label: string;
  tone: "up" | "down" | "flat" | "new";
} {
  if (previous === 0) {
    return current > 0
      ? { label: "new", tone: "new" }
      : { label: "0%", tone: "flat" };
  }

  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) {
    return { label: "0%", tone: "flat" };
  }

  const rounded = Math.round(change);
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}%`,
    tone: rounded > 0 ? "up" : "down",
  };
}
