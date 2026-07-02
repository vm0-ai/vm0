import { randomUUID } from "node:crypto";
import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";

const COMPUTER_USE_INSTALLATION_ID_KEY = "computerUseInstallationId";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readOrCreateComputerUseInstallationId(
  preferencesPath: string,
): string {
  const preferences = readDesktopPreferenceRecord(preferencesPath);
  const existing = preferences[COMPUTER_USE_INSTALLATION_ID_KEY];
  if (typeof existing === "string" && UUID_RE.test(existing)) {
    return existing;
  }

  const installationId = randomUUID();
  writeDesktopPreferenceRecord(preferencesPath, {
    ...preferences,
    [COMPUTER_USE_INSTALLATION_ID_KEY]: installationId,
  });
  return installationId;
}
