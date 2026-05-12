import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { SLACK_E2E_FIXTURES } from "../slack-mock-fixtures";

/**
 * Cross-file contract test: asserts the hand-maintained BATS mirror at
 * `e2e/helpers/slack-fixtures.sh` agrees with the shared TS fixture values.
 *
 * This is intentionally a contract check, not a unit test of internal
 * logic (no business behavior is exercised). Because the Slack mock
 * routes consume the TS constants while BATS assertions consume the
 * shell constants, a careless edit to only one file would silently
 * drift mock responses away from BATS expectations. The alternative —
 * code-generating the `.sh` file from the `.ts` source at build-time —
 * would be a stronger contract but adds build complexity we don't yet
 * need; this test keeps the invariant enforced at CI time.
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
