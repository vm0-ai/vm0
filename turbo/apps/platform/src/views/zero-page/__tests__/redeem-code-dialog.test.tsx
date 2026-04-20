/**
 * Tests for the redeem-code gift icon and dialog in the agent chat page header.
 *
 * Gated on the `redeemCode` feature switch. When enabled, a gift-icon button
 * (aria-label "Redeem code") appears in the chat page header. Clicking it
 * opens a dialog with an input and a Redeem button that stays disabled until
 * the input has non-whitespace content. Closing the dialog clears the input.
 *
 * See: turbo/apps/platform/src/views/zero-page/agent-chat-page.tsx
 * See: turbo/apps/platform/src/signals/zero-page/redeem-code-dialog.ts
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const CHAT_PATH = `/agents/${AGENT_ID}/chat`;

function getButtonByText(label: string): HTMLButtonElement {
  const match = screen.getAllByRole("button").find((el) => {
    return el.textContent?.trim() === label;
  });
  if (!match) {
    throw new Error(`No button with text "${label}"`);
  }
  return match as HTMLButtonElement;
}

describe("redeem-code gift icon visibility (RC-001)", () => {
  it("does not render the gift icon when redeemCode is off", async () => {
    detachedSetupPage({ context, path: CHAT_PATH });

    // Wait for the chat page header to be ready by checking a stable sibling.
    await waitFor(() => {
      expect(screen.getByTestId("chat-tagline")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Redeem code")).not.toBeInTheDocument();
  });

  it("renders the gift icon when redeemCode is on", async () => {
    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.RedeemCode]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Redeem code")).toBeInTheDocument();
    });
  });
});

describe("redeem-code dialog interaction (RC-002)", () => {
  it("opens the dialog with a disabled Redeem button when gift icon is clicked", async () => {
    const user = userEvent.setup();
    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.RedeemCode]: true },
    });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });

    await user.click(giftButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Enter code")).toBeInTheDocument();
    expect(getButtonByText("Redeem")).toBeDisabled();
  });

  it("enables the Redeem button once non-whitespace input is entered", async () => {
    const user = userEvent.setup();
    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.RedeemCode]: true },
    });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = await waitFor(() => {
      return screen.getByPlaceholderText("Enter code");
    });

    await user.type(input, "   ");
    expect(getButtonByText("Redeem")).toBeDisabled();

    await user.type(input, "CODE123");
    expect(getButtonByText("Redeem")).toBeEnabled();
  });

  it("clears the input after closing via Cancel and reopening", async () => {
    const user = userEvent.setup();
    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.RedeemCode]: true },
    });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = (await waitFor(() => {
      return screen.getByPlaceholderText("Enter code");
    })) as HTMLInputElement;
    await user.type(input, "CODE123");
    expect(input.value).toBe("CODE123");

    await user.click(getButtonByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Redeem code"));

    const reopenedInput = (await waitFor(() => {
      return screen.getByPlaceholderText("Enter code");
    })) as HTMLInputElement;
    expect(reopenedInput.value).toBe("");
  });
});
