import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { SLACK_E2E_FIXTURES } from "../slack-mock-fixtures";

/**
 * The canonical Slack e2e fixture identifiers live in
 * `src/lib/test-endpoints/slack-mock-fixtures.ts` and are mirrored into
 * `e2e/helpers/slack-fixtures.sh` so the BATS suite can consume them.
 *
 * This test parses the shell file and asserts each mirrored constant
 * matches the TS source, so a careless edit to only one file is caught
 * in CI instead of silently drifting the mock responses away from the
 * BATS assertions.
 */

const SHELL_FIXTURES_PATH = resolve(
  __dirname,
  "../../../../../../../e2e/helpers/slack-fixtures.sh",
);

function parseShellExports(contents: string): Map<string, string> {
  const entries = new Map<string, string>();
  const re = /^export\s+([A-Z_]+)="([^"]*)"/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(contents)) !== null) {
    const [, name, value] = match;
    if (name && value !== undefined) {
      entries.set(name, value);
    }
  }
  return entries;
}

describe("slack-mock-fixtures drift", () => {
  it("shell mirror matches the TS source of truth", () => {
    const contents = readFileSync(SHELL_FIXTURES_PATH, "utf8");
    const shell = parseShellExports(contents);

    const expected: Record<string, string> = {
      SLACK_FIXTURE_BOT_USER_ID: SLACK_E2E_FIXTURES.botUserId,
      SLACK_FIXTURE_USER_USER_ID: SLACK_E2E_FIXTURES.userUserId,
      SLACK_FIXTURE_BOT_ID: SLACK_E2E_FIXTURES.botId,
      SLACK_FIXTURE_TEAM_ID: SLACK_E2E_FIXTURES.teamId,
      SLACK_FIXTURE_APP_ID: SLACK_E2E_FIXTURES.appId,
      SLACK_FIXTURE_CHANNEL_ID: SLACK_E2E_FIXTURES.channelId,
      SLACK_FIXTURE_BOT_TOKEN: SLACK_E2E_FIXTURES.botToken,
      SLACK_FIXTURE_TEAM_NAME: SLACK_E2E_FIXTURES.teamName,
    };

    for (const [shellVar, tsValue] of Object.entries(expected)) {
      expect(shell.get(shellVar), `${shellVar} must be exported`).toBe(tsValue);
    }

    // Also ensure the shell file does not export extra, un-mirrored keys —
    // each export must correspond to a TS source constant.
    const allowedKeys = new Set(Object.keys(expected));
    for (const key of shell.keys()) {
      expect(allowedKeys.has(key), `${key} not tracked in TS source`).toBe(
        true,
      );
    }
  });
});
