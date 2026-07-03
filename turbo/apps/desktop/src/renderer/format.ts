export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(value: number | null): string {
  if (value === null) {
    return "In progress";
  }
  if (value < 1_000) {
    return `${value} ms`;
  }
  return `${(value / 1_000).toFixed(1)} s`;
}

export function formatRecoveryDelay(value: number): string {
  if (value < 1_000) {
    return "now";
  }
  if (value < 60_000) {
    return `${Math.ceil(value / 1_000)}s`;
  }
  return `${Math.ceil(value / 60_000)}m`;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

export function previewValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return formatJson(value);
}
