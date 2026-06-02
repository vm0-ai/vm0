import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  type UserPreferencesResponse,
  zeroUserPreferencesContract,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function createMockPreferences(
  overrides?: Partial<UserPreferencesResponse>,
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    pinnedAgentIds: [],
    sendMode: "enter",
    captureNetworkBodiesRemaining: 0,
    ...overrides,
  };
}

function mockPreferencesAPI(prefs = createMockPreferences()) {
  setMockUserPreferences(prefs);
}

function renderPreferencesPage() {
  detachedSetupPage({ context, path: "/settings" });
}

describe("zero preferences page - tab navigation", () => {
  it("loads preferences through the api host", async () => {
    vi.stubGlobal("location", new URL("https://platform.vm0.ai/settings"));
    const requestHosts: string[] = [];

    server.use(
      mockApi(zeroUserPreferencesContract.get, ({ request, respond }) => {
        requestHosts.push(new URL(request.url).host);
        return respond(200, createMockPreferences());
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
    expect(requestHosts).toStrictEqual(["api.vm0.ai"]);
  });

  it("should show appearance tab by default and switch to time zone tab", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
  });

  it("should switch back to appearance tab from time zone", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
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
});

describe("zero preferences page - send mode interaction", () => {
  it("should send update request when changing send mode", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setMockUserPreferences(createMockPreferences({ sendMode: "enter" }));
    server.use(
      mockApi(zeroUserPreferencesContract.update, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(200, createMockPreferences({ sendMode: "cmd-enter" }));
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterButton = queryAllByRoleFast("button").find((btn) => {
      return (
        btn.textContent?.includes("Enter") &&
        btn.textContent?.includes("\u2318")
      );
    });
    expect(cmdEnterButton).toBeInTheDocument();
    click(cmdEnterButton as HTMLElement);

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("sendMode", "cmd-enter");
  });
});

describe("zero preferences page - timezone update", () => {
  it("should render timezone settings with current value when switching to timezone tab", async () => {
    mockPreferencesAPI(createMockPreferences({ timezone: "Asia/Tokyo" }));
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // Verify the combobox trigger displays the label for the current timezone (Asia/Tokyo)
    expect(screen.getByText(/Japan Standard Time \(JST\)/)).toBeInTheDocument();
  });

  it("should send update request when changing timezone", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    setMockUserPreferences(createMockPreferences({ timezone: "UTC" }));
    server.use(
      mockApi(zeroUserPreferencesContract.update, ({ body, respond }) => {
        capturedBody = body as Record<string, unknown>;
        return respond(
          200,
          createMockPreferences({ timezone: "America/New_York" }),
        );
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    // Open the select dropdown
    const selectTrigger = screen.getByRole("combobox");
    click(selectTrigger);

    // Select a different timezone
    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", "America/New_York");
  });
});
