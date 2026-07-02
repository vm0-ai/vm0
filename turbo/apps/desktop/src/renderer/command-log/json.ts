const RESULT_SUMMARY_KEYS_TO_SKIP = new Set([
  "appState",
  "elements",
  "screenshot",
  "visibleElements",
]);
const RESULT_APP_STATE_PREVIEW_LABEL = "[shown in App State]";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordStringValue(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function recordNumberValue(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function visibleElementRecords(
  result: Record<string, unknown> | null,
): readonly Record<string, unknown>[] {
  const value = result?.visibleElements;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function jsonDisplayRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === "screenshot" &&
      typeof entry === "string" &&
      entry.startsWith("data:image/")
    ) {
      next[key] = `[image data URL, ${entry.length} characters]`;
    } else {
      next[key] = jsonDisplayValue(entry);
    }
  }
  return next;
}

export function jsonDisplayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      return jsonDisplayValue(entry);
    });
  }
  if (isRecord(value)) {
    return jsonDisplayRecord(value);
  }
  return value;
}

export function resultSummaryRecord(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (!RESULT_SUMMARY_KEYS_TO_SKIP.has(key)) {
      summary[key] = jsonDisplayValue(value);
    }
  }
  if (recordStringValue(result, "appState")) {
    summary.appState = RESULT_APP_STATE_PREVIEW_LABEL;
  }
  if (recordStringValue(result, "screenshot")) {
    summary.screenshot = "[shown as image]";
  }
  const elements = result.elements;
  if (Array.isArray(elements)) {
    summary.elements = `${elements.length} elements`;
  }
  const visibleElements = result.visibleElements;
  if (Array.isArray(visibleElements)) {
    summary.visibleElements = `${visibleElements.length} visible elements`;
  }
  return summary;
}

export function screenshotMeta(result: Record<string, unknown> | null): string {
  const sourceName = recordStringValue(result, "screenshotSourceName");
  const width = recordNumberValue(result, "screenshotWidth");
  const height = recordNumberValue(result, "screenshotHeight");
  const dimensions =
    width !== null && height !== null ? `${width}x${height}` : null;
  return [sourceName, dimensions].filter(Boolean).join(" - ");
}
