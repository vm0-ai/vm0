import { screen, waitFor } from "@testing-library/react";
import { zeroIntegrationsAgentPhoneContract } from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const phoneHandle = "+15551234567";

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function agentPhoneConnectPath(): string {
  const params = new URLSearchParams({
    handle: phoneHandle,
    agent: "agentphone-agent-1",
    ts: "1700000000",
    sig: "c".repeat(64),
    channel: "sms",
  });
  return `/agentphone/connect?${params.toString()}`;
}

describe("zero AgentPhone connect page", () => {
  it("links a phone number from a text-message connect link", async () => {
    context.mocks.api(
      zeroIntegrationsAgentPhoneContract.connectAgentPhone,
      ({ body, respond }) => {
        return respond(200, { phoneHandle: body.phoneHandle });
      },
    );

    detachedSetupPage({
      context,
      path: agentPhoneConnectPath(),
    });

    await waitFor(() => {
      expect(screen.getByText("Connect phone number")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "SMS and MMS replies may not be delivered reliably. For the most reliable experience, use iMessage with this AgentPhone number.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Phone number connected")).toBeInTheDocument();
    });
    expect(screen.getByText(phoneHandle)).toBeInTheDocument();
    expect(screen.getByText("Back to VM0")).toBeInTheDocument();
  });
});
