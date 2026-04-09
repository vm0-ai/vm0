import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type { UserPreferencesResponse } from "@vm0/core";

const context = testContext();

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
  server.use(
    http.get("*/api/zero/user-preferences", () => {
      return HttpResponse.json(prefs);
    }),
  );
}

function renderPreferencesPage() {
  detachedSetupPage({ context, path: "/settings" });
}

describe("zero preferences page - tab navigation", () => {
  it("should show appearance tab by default and switch to time zone tab", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
  });

  it("should switch back to appearance tab from time zone", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Appearance"));

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
  });
});

describe("zero preferences page - send mode interaction", () => {
  it("should send update request when changing send mode", async () => {
    const user = userEvent.setup();
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json(createMockPreferences({ sendMode: "enter" }));
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          createMockPreferences({ sendMode: "cmd-enter" }),
        );
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Send message with")).toBeInTheDocument();
    });

    const cmdEnterButton = screen.getAllByRole("button").find((btn) => {
      return (
        btn.textContent?.includes("Enter") &&
        btn.textContent?.includes("\u2318")
      );
    });
    expect(cmdEnterButton).toBeInTheDocument();
    await user.click(cmdEnterButton as HTMLElement);

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("sendMode", "cmd-enter");
  });
});

describe("zero preferences page - timezone update", () => {
  it("should render timezone settings with current value when switching to timezone tab", async () => {
    const user = userEvent.setup();
    mockPreferencesAPI(createMockPreferences({ timezone: "Asia/Tokyo" }));
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // Verify the combobox trigger displays the label for the current timezone (Asia/Tokyo)
    expect(screen.getByText(/Japan Standard Time \(JST\)/)).toBeInTheDocument();
  });

  it("should send update request when changing timezone", async () => {
    const user = userEvent.setup();
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json(createMockPreferences({ timezone: "UTC" }));
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          createMockPreferences({ timezone: "America/New_York" }),
        );
      }),
    );

    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Time Zone")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    // Open the select dropdown
    const selectTrigger = screen.getByRole("combobox");
    await user.click(selectTrigger);

    // Select a different timezone
    await waitFor(() => {
      expect(screen.getByText(/Eastern Time \(ET\)/)).toBeInTheDocument();
    });
    await user.click(screen.getByText(/Eastern Time \(ET\)/));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", "America/New_York");
  });
});
