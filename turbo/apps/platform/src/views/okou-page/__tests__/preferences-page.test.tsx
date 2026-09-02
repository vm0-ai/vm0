import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const { set$: setStoredTheme$ } = localStorageSignals("theme");
const { set$: setStoredColorTheme$ } = localStorageSignals("colorTheme");

function defaultPreferences(): UserPreferencesResponse {
  return {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US", "pt-BR"],
    pinnedAgentIds: [],
    sendMode: "enter",
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
  };
}

function mockPreferences(
  overrides: Partial<UserPreferencesResponse> = {},
): UpdateUserPreferencesRequest[] {
  let preferences: UserPreferencesResponse = {
    ...defaultPreferences(),
    ...overrides,
  };
  const updates: UpdateUserPreferencesRequest[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    const update = { ...body };
    updates.push(update);
    preferences = { ...preferences, ...update };
    return respond(200, preferences);
  });
  return updates;
}

function getFastRole(
  role: Parameters<typeof queryAllByRoleFast>[0],
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string"
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!element) {
    throw new Error(`${role} not found: ${name}`);
  }
  return element;
}

function expectSelected(element: HTMLElement): void {
  const selectionAttribute =
    element.getAttribute("aria-checked") ??
    element.getAttribute("aria-pressed");
  expect(selectionAttribute).toBe("true");
}

test("Existing device appearance choices are preserved when account settings are empty", async () => {
  context.store.set(setStoredTheme$, "dark");
  context.store.set(setStoredColorTheme$, "daydream");
  const updates = mockPreferences({ theme: null, colorTheme: null });

  await setupPage({
    context,
    path: "/settings",
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Dark"));
  expectSelected(getFastRole("button", "Daydream", colorTheme));
  await waitFor(() => {
    expect(updates).toContainEqual({
      theme: "dark",
      colorTheme: "daydream",
    });
  });
});

test("A user can change theme while reviewing the unified preferences", async () => {
  mockPreferences();

  await setupPage({ context, path: "/settings", host: "app.vm0.ai" });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  click(getFastRole("button", "Dark"));

  await waitFor(() => {
    expectSelected(getFastRole("button", "Dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  await expect(
    screen.findByText("Your agents will use this time zone during runs"),
  ).resolves.toBeVisible();
  expect(getFastRole("button", "Dark")).toBeVisible();
});

test("Account-backed appearance preferences are restored and saved", async () => {
  const updates = mockPreferences({
    theme: "dark",
    colorTheme: "golden-hour",
  });

  await setupPage({
    context,
    path: "/settings",
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Dark"));
  expectSelected(getFastRole("button", "Golden hour", colorTheme));

  click(getFastRole("button", "Light"));

  await waitFor(() => {
    expect(updates).toContainEqual({ theme: "light" });
    expectSelected(getFastRole("button", "Light"));
  });

  click(getFastRole("button", "Limelight", colorTheme));

  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "limelight" });
    expectSelected(getFastRole("button", "Limelight", colorTheme));
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "limelight",
  );
});

test("A user can select a gradient color theme when available", async () => {
  const updates = mockPreferences({ colorTheme: "blue-horizon" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
  });

  const colorTheme = await screen.findByRole("group", { name: "Color theme" });
  expectSelected(getFastRole("button", "Blue horizon", colorTheme));
  click(getFastRole("button", "Golden hour", colorTheme));

  await waitFor(() => {
    expect(updates).toContainEqual({ colorTheme: "golden-hour" });
    expectSelected(getFastRole("button", "Golden hour", colorTheme));
  });
  expect(document.documentElement).toHaveAttribute(
    "data-color-theme",
    "golden-hour",
  );
});

test("Gradient color themes stay hidden when the capability is disabled", async () => {
  mockPreferences({ colorTheme: "blue-horizon" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.vm0.ai",
    featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: false },
  });

  await expect(
    screen.findByText("Your preferred color scheme"),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("group", { name: "Color theme" })).toBeNull();
  expect(document.documentElement).not.toHaveAttribute(
    "data-gradient-color-themes",
  );
  expect(document.documentElement).not.toHaveAttribute("data-color-theme");
});

test("Localized preference labels save the same account choices", async () => {
  const updates = mockPreferences({ locale: "pt-BR" });

  await setupPage({
    context,
    path: "/settings",
    host: "app.vm0.ai",
    locale: "pt-BR",
  });

  await expect(screen.findByText("Enviar mensagem com")).resolves.toBeVisible();
  expect(screen.getByText("Escolha a aparência da interface.")).toBeVisible();
  click(getFastRole("button", "⌘ Enter"));

  await waitFor(() => {
    expect(updates).toContainEqual({ sendMode: "cmd-enter" });
  });

  const timezone = getFastRole("combobox", /UTC/u);
  click(timezone);
  const brasilia = await screen.findByRole("option", {
    name: /Horário de Brasília \(BRT\)$/u,
  });
  click(brasilia);

  await waitFor(() => {
    expect(updates).toContainEqual({ timezone: "America/Sao_Paulo" });
  });
});

test("A user can save message-send and time-zone preferences", async () => {
  const updates = mockPreferences();

  await setupPage({ context, path: "/settings", host: "app.vm0.ai" });

  await expect(screen.findByText("Send message with")).resolves.toBeVisible();
  click(getFastRole("button", "⌘ Enter"));

  await waitFor(() => {
    expect(updates).toContainEqual({ sendMode: "cmd-enter" });
  });

  const timezone = getFastRole("combobox", /UTC/u);
  click(timezone);
  const eastern = await screen.findByRole("option", {
    name: /Eastern Time \(ET\)$/u,
  });
  click(eastern);

  await waitFor(() => {
    expect(updates).toContainEqual({ timezone: "America/New_York" });
  });
});
