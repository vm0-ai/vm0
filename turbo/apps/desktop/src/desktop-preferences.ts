import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function isDesktopPreferenceRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readDesktopPreferenceRecord(
  filePath: string,
): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return isDesktopPreferenceRecord(parsed) ? parsed : {};
}

export function writeDesktopPreferenceRecord(
  filePath: string,
  preferences: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}
