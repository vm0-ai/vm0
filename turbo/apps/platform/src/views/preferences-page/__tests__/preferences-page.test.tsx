import { screen, waitFor } from "@testing-library/react";
import {
  SUPPORTED_USER_LOCALES,
  type UserPreferencesResponse,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  MOCK_BACKEND_COMMIT_SHA,
  MOCK_BACKEND_VERSION,
} from "../../../mocks/handlers/api-build-info.ts";
import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const TEST_FRONTEND_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_FRONTEND_VERSION = "0.540.0";
const themeStorage = localStorageSignals("theme");
const colorThemeStorage = localStorageSignals("colorTheme");

function createMockPreferences(
  overrides?: Partial<UserPreferencesResponse>,
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: [...SUPPORTED_USER_LOCALES],
    pinnedAgentIds: [],
    sendMode: "enter",
    theme: "system",
    colorTheme: "blue-horizon",
    morningBriefEnabled: false,
    morningBriefNextRunAt: null,
    captureNetworkBodiesRemaining: 0,
    ...overrides,
  };
}

function renderPreferencesPage(): void {
  detachedSetupPage({ context, path: "/settings" });
}

function getSegmentByText(text: string): HTMLElement {
  const segment = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!segment) {
    throw new Error(`Segment not found: ${text}`);
  }
  return segment;
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("preferences page", () => {
  it("switches between preference tabs", async () => {
    context.mocks.data.userPreferences(createMockPreferences());

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    const darkSegment = getSegmentByText("Dark");
    click(darkSegment);

    await waitFor(() => {
      expect(darkSegment).toHaveAttribute("aria-checked", "true");
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    click(screen.getByText("Appearance"));

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
  });

  it("keeps gradient color themes behind their feature switch", async () => {
    context.mocks.data.userPreferences(createMockPreferences());

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
    expect(screen.queryByText("Color theme")).not.toBeInTheDocument();
    expect(
      document.querySelector(".zero-app[data-gradient-color-themes]"),
    ).not.toBeInTheDocument();
    expect(document.documentElement).not.toHaveAttribute(
      "data-gradient-color-themes",
    );
    expect(document.documentElement).not.toHaveAttribute("data-color-theme");
  });

  it("selects a palette-derived interface theme", async () => {
    context.mocks.data.userPreferences(createMockPreferences());

    detachedSetupPage({
      context,
      path: "/settings",
      featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Blue horizon")).toBeInTheDocument();
    });
    const blueHorizon = getButtonByText("Blue horizon");
    const app = document.querySelector(".zero-app");
    expect(app).toHaveAttribute("data-gradient-color-themes");
    expect(app).toHaveAttribute("data-color-theme", "blue-horizon");
    expect(document.documentElement).toHaveAttribute(
      "data-gradient-color-themes",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-color-theme",
      "blue-horizon",
    );
    expect(blueHorizon).toHaveAttribute("aria-pressed", "true");

    click(getButtonByText("Golden hour"));

    await waitFor(() => {
      expect(app).toHaveAttribute("data-color-theme", "golden-hour");
      expect(document.documentElement).toHaveAttribute(
        "data-color-theme",
        "golden-hour",
      );
      expect(getButtonByText("Golden hour")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("restores and saves server-backed appearance preferences", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    let storedPreferences = createMockPreferences({
      theme: "dark",
      colorTheme: "golden-hour",
    });
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, storedPreferences);
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      capturedBodies.push(body as Record<string, unknown>);
      storedPreferences = { ...storedPreferences, ...body };
      return respond(200, storedPreferences);
    });

    detachedSetupPage({
      context,
      path: "/settings",
      featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
      expect(screen.getByText("Golden hour")).toBeInTheDocument();
    });
    const darkSegment = getSegmentByText("Dark");
    await waitFor(() => {
      expect(darkSegment).toHaveAttribute("aria-checked", "true");
      expect(getButtonByText("Golden hour")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    click(getSegmentByText("Light"));
    click(getButtonByText("Limelight"));

    await waitFor(() => {
      expect(capturedBodies).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ theme: "light" }),
          expect.objectContaining({ colorTheme: "limelight" }),
        ]),
      );
    });
  });

  it("migrates cached appearance choices when server preferences are unset", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    let storedPreferences = createMockPreferences({
      theme: null,
      colorTheme: null,
    });
    context.store.set(themeStorage.set$, "dark");
    context.store.set(colorThemeStorage.set$, "daydream");
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, storedPreferences);
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      capturedBodies.push(body as Record<string, unknown>);
      storedPreferences = { ...storedPreferences, ...body };
      return respond(200, storedPreferences);
    });

    detachedSetupPage({
      context,
      path: "/settings",
      featureSwitches: { [FeatureSwitchKey.GradientColorThemes]: true },
    });

    await waitFor(() => {
      expect(capturedBodies).toContainEqual({
        theme: "dark",
        colorTheme: "daydream",
      });
      expect(getSegmentByText("Dark")).toHaveAttribute("aria-checked", "true");
      expect(getButtonByText("Daydream")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("keeps appearance choices local when served by an older API", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const oldPreferences = createMockPreferences();
    delete oldPreferences.theme;
    delete oldPreferences.colorTheme;
    context.store.set(themeStorage.set$, "system");
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, oldPreferences);
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      capturedBodies.push(body as Record<string, unknown>);
      return respond(200, { ...oldPreferences, ...body });
    });

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
    click(getSegmentByText("Dark"));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    });
    expect(capturedBodies).toStrictEqual([]);
  });

  it("saves send mode and time zone preference changes", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    context.mocks.data.userPreferences(
      createMockPreferences({ timezone: "UTC" }),
    );
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      capturedBodies.push(body as Record<string, unknown>);
      return respond(200, {
        ...createMockPreferences(),
        ...(body as Partial<UserPreferencesResponse>),
      });
    });

    renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterSegment = queryAllByRoleFast("radio").find((segment) => {
      return (
        segment.textContent?.includes("Enter") &&
        segment.textContent?.includes("\u2318")
      );
    });
    expect(cmdEnterSegment).toBeInTheDocument();
    click(cmdEnterSegment as HTMLElement);

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    click(screen.getByRole("combobox"));

    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(capturedBodies).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ sendMode: "cmd-enter" }),
          expect.objectContaining({ timezone: "America/New_York" }),
        ]),
      );
    });
  });

  it("changes debug network body capture on the preferences page", async () => {
    context.mocks.data.userPreferences(
      createMockPreferences({ captureNetworkBodiesRemaining: 0 }),
    );

    detachedSetupPage({
      context,
      path: "/settings?tab=debug",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Build information")).toBeInTheDocument();
      expect(screen.getByText("Frontend")).toBeInTheDocument();
      expect(screen.getByText(TEST_FRONTEND_VERSION)).toBeInTheDocument();
      expect(screen.getByText(TEST_FRONTEND_COMMIT_SHA)).toBeInTheDocument();
      expect(screen.getByText("Backend")).toBeInTheDocument();
      expect(screen.getByText(MOCK_BACKEND_VERSION)).toBeInTheDocument();
      expect(screen.getByText(MOCK_BACKEND_COMMIT_SHA)).toBeInTheDocument();
      expect(screen.getAllByText("Commit SHA")).toHaveLength(2);
      expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(
        screen.getByText("Enabled for the next 3 runs"),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });

  it("keeps preference identifiers stable in Brazilian Portuguese", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    context.mocks.data.userPreferences(
      createMockPreferences({
        locale: "pt-BR",
        supportedLocales: ["en-US", "pt-BR"],
        timezone: "UTC",
      }),
    );
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      capturedBodies.push(body as Record<string, unknown>);
      return respond(200, {
        ...createMockPreferences({
          locale: "pt-BR",
          supportedLocales: ["en-US", "pt-BR"],
        }),
        ...(body as Partial<UserPreferencesResponse>),
      });
    });

    detachedSetupPage({
      context,
      path: "/settings",
    });

    await waitFor(() => {
      expect(screen.getByText("Enviar mensagem com")).toBeInTheDocument();
      expect(screen.getByText("Seu esquema de cores preferido")).toBeVisible();
    });

    click(getSegmentByText("⌘ Enter"));
    click(screen.getByText("Fuso horário"));

    await waitFor(() => {
      expect(screen.getByText("Fuso horário")).toBeInTheDocument();
    });
    click(screen.getByRole("combobox"));
    click(screen.getByText(/Horário de Brasília \(BRT\)/u));

    await waitFor(() => {
      expect(capturedBodies).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ sendMode: "cmd-enter" }),
          expect.objectContaining({ timezone: "America/Sao_Paulo" }),
        ]),
      );
    });
  });
});
