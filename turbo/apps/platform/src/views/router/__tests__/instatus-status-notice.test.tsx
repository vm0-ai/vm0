import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
  setupPageAndWaitForContent,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const INSTATUS_ISSUES_ENDPOINT = "https://api.instatus.com/issues";

function mockActiveIssues(): void {
  context.mocks.http.get(INSTATUS_ISSUES_ENDPOINT, () => {
    return HttpResponse.json({
      activeIncidents: [
        {
          id: "incident-123",
          name: "Elevated API errors",
          status: "INVESTIGATING",
          updatedAt: "2026-09-01T08:00:00.000Z",
        },
      ],
      activeMaintenances: [
        {
          id: "maintenance-456",
          name: "Database maintenance",
          status: "NOTSTARTEDYET",
          updatedAt: "2026-09-01T08:00:00.000Z",
          date: "2026-09-02T02:00:00.000Z",
        },
      ],
    });
  });
}

describe("instatus status notice", () => {
  it.each(["app.vm0.ai", "app.okou.ai"])(
    "renders branded active status updates on %s",
    async (hostname) => {
      const user = userEvent.setup();
      context.mocks.browser.url(`https://${hostname}/`);
      context.mocks.browser.matchMedia(true);
      mockActiveIssues();

      detachedSetupPage({ context, path: "/" });

      const incident = await screen.findByRole("status", {
        name: "Investigating: Elevated API errors",
      });
      const updatesLink = queryAllByRoleFast("link", incident).find((link) => {
        return link.textContent?.trim() === "View latest updates";
      });
      expect(updatesLink).toHaveAttribute(
        "href",
        "https://status.okou.ai/incident-123",
      );
      await expect(
        screen.findAllByRole("status", {
          name: "Maintenance scheduled: Database maintenance",
        }),
      ).resolves.not.toHaveLength(0);

      const dismissButton = queryAllByRoleFast("button", incident).find(
        (button) => {
          return button.getAttribute("aria-label") === "Dismiss service update";
        },
      );
      expect(dismissButton).toBeDefined();
      await user.click(dismissButton!);

      await waitFor(() => {
        expect(
          screen.queryByRole("status", {
            name: "Investigating: Elevated API errors",
          }),
        ).not.toBeInTheDocument();
      });
    },
  );

  it("places the mobile status notice inside the expanded sidebar", async () => {
    const user = userEvent.setup();
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.matchMedia(false);
    mockActiveIssues();

    detachedSetupPage({ context, path: "/" });

    const openMenuButton = await waitFor(() => {
      const button = queryAllByRoleFast("button").find((candidate) => {
        return candidate.getAttribute("aria-label") === "Open menu";
      });
      expect(button).toBeDefined();
      return button;
    });
    await user.click(openMenuButton!);

    const mobileSidebar = await screen.findByRole("complementary", {
      name: "Sidebar",
    });
    const sidebarIncident = within(mobileSidebar).getByRole("status", {
      name: "Investigating: Elevated API errors",
    });
    expect(screen.getAllByRole("status")).toStrictEqual([
      sidebarIncident,
      within(mobileSidebar).getByRole("status", {
        name: "Maintenance scheduled: Database maintenance",
      }),
    ]);
  });

  it("renders maintenance when Instatus omits the inactive incident list", async () => {
    context.mocks.browser.url("https://app.okou.ai/");
    context.mocks.browser.matchMedia(true);
    context.mocks.http.get(INSTATUS_ISSUES_ENDPOINT, () => {
      return HttpResponse.json({
        activeMaintenances: [
          {
            id: "maintenance-456",
            name: "Database maintenance",
            status: "NOTSTARTEDYET",
          },
        ],
      });
    });

    detachedSetupPage({ context, path: "/" });

    await expect(
      screen.findByRole("status", {
        name: "Maintenance scheduled: Database maintenance",
      }),
    ).resolves.toBeInTheDocument();
  });

  it("does not request or render status updates on preview hosts", async () => {
    let requestCount = 0;
    context.mocks.browser.url("https://pr-123-app.omby.ai/");
    context.mocks.http.get(INSTATUS_ISSUES_ENDPOINT, () => {
      requestCount += 1;
      return HttpResponse.json({
        activeIncidents: [],
        activeMaintenances: [],
      });
    });

    await setupPageAndWaitForContent({ context, path: "/" });

    expect(requestCount).toBe(0);
    expect(
      screen.queryByLabelText("Service status updates"),
    ).not.toBeInTheDocument();
  });
});
