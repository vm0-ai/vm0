import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mountMockClerkProfilePortal() {
  const portal = document.createElement("div");
  portal.setAttribute("role", "dialog");
  portal.setAttribute("aria-label", "Clerk user profile");
  portal.dataset.clerkUserProfile = "true";
  portal.className = "cl-userProfile-root cl-modalContent";

  const action = document.createElement("button");
  action.type = "button";
  action.textContent = "Update profile";
  portal.append(action);

  document.body.append(portal);
  context.signal.addEventListener("abort", () => {
    portal.remove();
  });

  return Promise.resolve();
}

describe("settings dialog - Clerk profile modal", () => {
  it("keeps settings open when interacting with the Clerk user profile modal", async () => {
    mockedClerk.openUserProfile.mockImplementationOnce(
      mountMockClerkProfilePortal,
    );

    detachedSetupPage({ context, path: "/?settings=preference" });

    const settingsDialog = await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect(within(dialog).getAllByText("Preference").length).toBeGreaterThan(
        0,
      );
      return dialog;
    });

    click(within(settingsDialog).getByText("Manage"));

    const clerkDialog = await waitFor(() => {
      return screen.getByRole("dialog", { name: "Clerk user profile" });
    });

    fireEvent.pointerDown(within(clerkDialog).getByText("Update profile"), {
      button: 0,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
    });
  });
});
