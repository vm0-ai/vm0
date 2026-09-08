import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

function isDesktopPreferenceRecord(
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
  if (!isDesktopPreferenceRecord(parsed))
    throw new Error("Desktop preferences must be an object");
  return parsed;
}

export function writeDesktopPreferenceRecord(
  filePath: string,
  preferences: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}
