import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const COMPUTER_USE_INSTALLATION_ID_KEY = "computerUseInstallationId";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPreferenceRecord(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function writePreferenceRecord(
  filePath: string,
  preferences: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

export function readOrCreateComputerUseInstallationId(
  preferencesPath: string,
): string {
  const preferences = readPreferenceRecord(preferencesPath);
  const existing = preferences[COMPUTER_USE_INSTALLATION_ID_KEY];
  if (typeof existing === "string" && UUID_RE.test(existing)) {
    return existing;
  }

  const installationId = randomUUID();
  writePreferenceRecord(preferencesPath, {
    ...preferences,
    [COMPUTER_USE_INSTALLATION_ID_KEY]: installationId,
  });
  return installationId;
}
