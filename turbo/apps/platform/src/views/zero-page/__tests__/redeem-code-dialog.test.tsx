/**
 * Tests for the redeem-code gift icon and dialog in the agent chat page header.
 *
 * A gift-icon button (aria-label "Redeem code") appears in the chat page
 * header. Clicking it opens a dialog with an input and a Redeem button that
 * stays disabled until the input has non-whitespace content. Closing the
 * dialog clears the input.
 *
 * See: turbo/apps/platform/src/views/zero-page/agent-chat-page.tsx
 * See: turbo/apps/platform/src/signals/zero-page/redeem-code-dialog.ts
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroRedemptionCodesRedeemContract } from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";

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
  it("renders the gift icon in the chat page header", async () => {
    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Redeem code")).toBeInTheDocument();
    });
  });
});

describe("redeem-code dialog interaction (RC-002)", () => {
  it("opens the dialog with a disabled Redeem button when gift icon is clicked", async () => {
    const user = userEvent.setup();
    detachedSetupPage({ context, path: CHAT_PATH });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });

    await user.click(giftButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX"),
    ).toBeInTheDocument();
    expect(getButtonByText("Redeem")).toBeDisabled();
  });

  it("enables the Redeem button once non-whitespace input is entered", async () => {
    const user = userEvent.setup();
    detachedSetupPage({ context, path: CHAT_PATH });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = await waitFor(() => {
      return screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX");
    });

    await user.type(input, "   ");
    expect(getButtonByText("Redeem")).toBeDisabled();

    await user.type(input, "CODE123");
    expect(getButtonByText("Redeem")).toBeEnabled();
  });

  it("calls the redeem endpoint with the entered code and closes the dialog on success (RC-003)", async () => {
    const user = userEvent.setup();

    let capturedBody: unknown;
    server.use(
      mockApi(zeroRedemptionCodesRedeemContract.redeem, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, { credits: 2500, newBalance: 2500 });
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = await waitFor(() => {
      return screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX");
    });
    await user.type(input, "VM0-ABCD-EFGH");

    await user.click(getButtonByText("Redeem"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedBody).toStrictEqual({ code: "VM0-ABCD-EFGH" });
  });

  it("keeps the dialog open and surfaces the error message on a 400 (RC-004)", async () => {
    const user = userEvent.setup();

    server.use(
      mockApi(zeroRedemptionCodesRedeemContract.redeem, ({ respond }) => {
        return respond(400, {
          error: {
            message: "Code is invalid, already redeemed, or expired",
            code: "BAD_REQUEST",
          },
        });
      }),
    );

    detachedSetupPage({ context, path: CHAT_PATH });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = await waitFor(() => {
      return screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX");
    });
    await user.type(input, "VM0-BADD-BADD");
    await user.click(getButtonByText("Redeem"));

    await waitFor(() => {
      expect(
        screen.getByText(/invalid, already redeemed, or expired/i),
      ).toBeInTheDocument();
    });
    // Dialog stays open so the user can retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clears the input after closing via Cancel and reopening", async () => {
    const user = userEvent.setup();
    detachedSetupPage({ context, path: CHAT_PATH });

    const giftButton = await waitFor(() => {
      return screen.getByLabelText("Redeem code");
    });
    await user.click(giftButton);

    const input = (await waitFor(() => {
      return screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX");
    })) as HTMLInputElement;
    await user.type(input, "CODE123");
    expect(input.value).toBe("CODE123");

    await user.click(getButtonByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Redeem code"));

    const reopenedInput = (await waitFor(() => {
      return screen.getByPlaceholderText("VM0-XXXX-XXXX-XXXX-XXXX");
    })) as HTMLInputElement;
    expect(reopenedInput.value).toBe("");
  });
});
