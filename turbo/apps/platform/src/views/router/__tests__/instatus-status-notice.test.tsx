import { screen, waitFor } from "@testing-library/react";
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
      mockActiveIssues();

      detachedSetupPage({ context, path: "/" });

      const incident = (
        await screen.findAllByRole("status", {
          name: "Investigating: Elevated API errors",
        })
      ).find((status) => {
        return status.closest("aside.zero-pwa-fixed-cover") === null;
      });
      if (!(incident instanceof HTMLElement)) {
        throw new Error("Floating incident notice not found");
      }
      const updatesLink = queryAllByRoleFast("link", incident).find((link) => {
        return link.textContent?.includes("View latest updates");
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
      if (!(dismissButton instanceof HTMLButtonElement)) {
        throw new Error("Dismiss button not found");
      }
      await user.click(dismissButton);

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
    mockActiveIssues();

    detachedSetupPage({ context, path: "/" });

    await screen.findAllByRole("status", {
      name: "Investigating: Elevated API errors",
    });
    const openMenuButton = queryAllByRoleFast("button").find((button) => {
      return button.getAttribute("aria-label") === "Open menu";
    });
    if (!(openMenuButton instanceof HTMLButtonElement)) {
      throw new Error("Open menu button not found");
    }
    await user.click(openMenuButton);

    const mobileSidebar = document.querySelector(
      "aside.zero-pwa-fixed-cover[data-sidebar-expanded]",
    );
    if (!(mobileSidebar instanceof HTMLElement)) {
      throw new Error("Expanded mobile sidebar not found");
    }
    const sidebarIncident = await waitFor(() => {
      const status = mobileSidebar.querySelector(
        '[role="status"][aria-label="Investigating: Elevated API errors"]',
      );
      if (!(status instanceof HTMLElement)) {
        throw new Error("Mobile sidebar incident notice not found");
      }
      return status;
    });
    expect(sidebarIncident).toBeInTheDocument();
    expect(
      sidebarIncident.closest('[aria-label="Service status updates"]'),
    ).not.toHaveClass("fixed");

    const floatingIncident = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="status"][aria-label="Investigating: Elevated API errors"]',
      ),
    ).find((status) => {
      return !mobileSidebar.contains(status);
    });
    expect(
      floatingIncident?.closest('[aria-label="Service status updates"]'),
    ).toHaveClass("max-md:hidden");
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
