import { screen, waitFor } from "@testing-library/react";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("email unsubscribe page", () => {
  it("unsubscribes from system emails after confirmation", async () => {
    context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
      return respond(200, { unsubscribed: true });
    });

    detachedSetupPage({
      context,
      path: "/email/unsubscribe?token=user_1.abc",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unsubscribe from email notifications?"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Unsubscribe"));

    await waitFor(() => {
      expect(screen.getByText("Unsubscribed")).toBeInTheDocument();
    });
  });

  it("shows an error state for an invalid token", async () => {
    context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
      return respond(400, { error: "Invalid token" });
    });

    detachedSetupPage({
      context,
      path: "/email/unsubscribe?token=broken",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unsubscribe from email notifications?"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Unsubscribe"));

    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });
});
