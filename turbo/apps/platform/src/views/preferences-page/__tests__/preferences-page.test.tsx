import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { UserPreferencesResponse } from "@vm0/core";

const context = testContext();

function createMockPreferences(
  overrides?: Partial<UserPreferencesResponse>,
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    pinnedAgentIds: [],
    sendMode: "enter",
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

async function renderPreferencesPage() {
  await setupPage({ context, path: "/preferences" });
}

describe("zero preferences page - tab navigation", () => {
  it("should show appearance tab by default and switch to time zone tab", async () => {
    mockPreferencesAPI();
    await renderPreferencesPage();

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Time Zone"));

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

    fireEvent.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Appearance"));

    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeInTheDocument();
    });
  });
});

describe("zero preferences page - send mode interaction", () => {
  it("should send update request when changing send mode", async () => {
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

    const cmdEnterButton = screen
      .getAllByRole("button")
      .find(
        (btn) =>
          btn.textContent?.includes("Enter") &&
          btn.textContent?.includes("\u2318"),
      );
    expect(cmdEnterButton).toBeInTheDocument();
    fireEvent.click(cmdEnterButton as HTMLElement);

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

    fireEvent.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });
    expect(screen.getByText("Japan Standard Time (JST)")).toBeInTheDocument();
  });

  it("should send update request when changing timezone", async () => {
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

    fireEvent.click(screen.getByText("Time Zone"));

    await waitFor(() => {
      expect(screen.getByText("Time zone")).toBeInTheDocument();
    });

    // Open the select dropdown
    const selectTrigger = screen.getByRole("combobox");
    fireEvent.click(selectTrigger);

    // Select a different timezone
    await waitFor(() => {
      expect(screen.getByText("Eastern Time (ET)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Eastern Time (ET)"));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toHaveProperty("timezone", "America/New_York");
  });
});
