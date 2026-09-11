import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

function preferences(timezone: string | null): UserPreferencesResponse {
  return {
    timezone,
    locale: "en-US",
    translationLanguage: null,
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
}

function mockTimezonePreferences(initialTimezone: string | null): string[] {
  let stored = preferences(initialTimezone);
  const timezoneUpdates: string[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.timezone !== undefined) {
      timezoneUpdates.push(body.timezone);
    }
    stored = { ...stored, ...body };
    return respond(200, stored);
  });
  return timezoneUpdates;
}

function setBrowserTimezone(timezone: string): void {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolved,
    timeZone: timezone,
  });
}

test("A member's first organization visit stores the browser timezone", async () => {
  const updates = mockTimezonePreferences(null);
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(updates).toStrictEqual(["Asia/Shanghai"]);
  });
});

test("A stored organization timezone is not replaced on a later visit", async () => {
  const updates = mockTimezonePreferences("America/Los_Angeles");
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  expect(updates).toHaveLength(0);
});
