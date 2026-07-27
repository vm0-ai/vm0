import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroBrowserAuthorizationRequestsContract } from "@vm0/api-contracts/contracts/zero-browser";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("browser authorization page", () => {
  it("enables the cloud browser for the requesting chat thread", async () => {
    const user = userEvent.setup({ delay: null });
    let enabled = false;

    context.mocks.api(
      zeroBrowserAuthorizationRequestsContract.get,
      ({ respond }) => {
        return respond(200, {
          expiresAt: "2026-07-27T12:00:00Z",
          completedAt: enabled ? "2026-07-27T11:00:00Z" : null,
          cloudBrowserEnabled: enabled,
        });
      },
    );
    context.mocks.api(
      zeroBrowserAuthorizationRequestsContract.apply,
      ({ respond }) => {
        enabled = true;
        return respond(200, { ok: true, cloudBrowserEnabled: true });
      },
    );

    detachedSetupPage({
      context,
      path: "/browser/authorize/vm0_browser_authorization_request_test",
    });

    await expect(
      screen.findByRole("heading", { name: "Enable cloud browser" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "Zero will use an isolated cloud browser profile for this chat thread. Enabling it disconnects Computer Use for the thread.",
      ),
    ).toBeInTheDocument();

    await user.click(getButtonByText("Enable for this thread"));

    await waitFor(() => {
      expect(enabled).toBeTruthy();
      expect(getButtonByText("Cloud browser enabled")).toBeDisabled();
    });
  });
});
