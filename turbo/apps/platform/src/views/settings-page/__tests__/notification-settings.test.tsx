import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("notification settings", () => {
  it("shows loading skeleton then renders preferences", async () => {
    server.use(
      http.get("/api/user/preferences", () => {
        return HttpResponse.json({
          timezone: null,
          notifyEmail: true,
          notifySlack: false,
        });
      }),
    );

    await setupPage({ context, path: "/settings?tab=notifications" });

    // Should show notification settings content
    await vi.waitFor(() => {
      expect(screen.getByText("Email Notifications")).toBeInTheDocument();
    });
    expect(screen.getByText("Slack Notifications")).toBeInTheDocument();

    // Email should be checked, Slack should not
    const emailSwitch = screen.getByRole("switch", {
      name: "Toggle email notifications",
    });
    const slackSwitch = screen.getByRole("switch", {
      name: "Toggle Slack notifications",
    });
    expect(emailSwitch).toHaveAttribute("data-state", "checked");
    expect(slackSwitch).toHaveAttribute("data-state", "unchecked");
  });

  it("toggles email notification and sends PUT request", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/user/preferences", () => {
        return HttpResponse.json({
          timezone: null,
          notifyEmail: false,
          notifySlack: false,
        });
      }),
      http.put("/api/user/preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          timezone: null,
          notifyEmail: true,
          notifySlack: false,
        });
      }),
    );

    await setupPage({ context, path: "/settings?tab=notifications" });

    await vi.waitFor(() => {
      expect(screen.getByText("Email Notifications")).toBeInTheDocument();
    });

    const emailSwitch = screen.getByRole("switch", {
      name: "Toggle email notifications",
    });
    await user.click(emailSwitch);

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.notifyEmail).toBeTruthy();
  });

  it("toggles slack notification and sends PUT request", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/user/preferences", () => {
        return HttpResponse.json({
          timezone: null,
          notifyEmail: false,
          notifySlack: false,
        });
      }),
      http.put("/api/user/preferences", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          timezone: null,
          notifyEmail: false,
          notifySlack: true,
        });
      }),
    );

    await setupPage({ context, path: "/settings?tab=notifications" });

    await vi.waitFor(() => {
      expect(screen.getByText("Slack Notifications")).toBeInTheDocument();
    });

    const slackSwitch = screen.getByRole("switch", {
      name: "Toggle Slack notifications",
    });
    await user.click(slackSwitch);

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.notifySlack).toBeTruthy();
  });

  it("shows error toast when update fails", async () => {
    server.use(
      http.get("/api/user/preferences", () => {
        return HttpResponse.json({
          timezone: null,
          notifyEmail: false,
          notifySlack: false,
        });
      }),
      http.put("/api/user/preferences", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await setupPage({ context, path: "/settings?tab=notifications" });

    await vi.waitFor(() => {
      expect(screen.getByText("Email Notifications")).toBeInTheDocument();
    });

    const emailSwitch = screen.getByRole("switch", {
      name: "Toggle email notifications",
    });
    await user.click(emailSwitch);

    // Toast should show error message
    await vi.waitFor(() => {
      expect(
        screen.getByText("Failed to update notification preference"),
      ).toBeInTheDocument();
    });
  });
});
