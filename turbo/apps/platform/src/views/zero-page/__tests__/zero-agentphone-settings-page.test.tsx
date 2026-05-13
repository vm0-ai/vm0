import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { setMockAgentPhoneIntegration } from "../../../mocks/handlers/api-integrations-agentphone.ts";

const context = testContext();

function setupAgentPhoneSettingsPage() {
  detachedSetupPage({
    context,
    path: "/settings/agentphone",
    featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
  });
}

describe("agentphone settings page", () => {
  it("starts verification and refreshes when AgentPhone connects", async () => {
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    setupAgentPhoneSettingsPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Connect AgentPhone")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect AgentPhone"));
    const input = await screen.findByTestId("agentphone-phone-input");
    await fill(input, "+1 (555) 555-1212");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-normalized-phone"),
      ).toHaveTextContent("+15555551212");
    });

    click(screen.getByText("Send verification"));

    await waitFor(() => {
      expect(
        screen.getByText(/Verification text sent to \+15555551212/i),
      ).toBeInTheDocument();
      expect(screen.getByText("Connecting...")).toBeDisabled();
    });
    await waitFor(() => {
      expect(hasSubscription("agentphone:changed")).toBeTruthy();
    });

    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    triggerAblyEvent("agentphone:changed");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("Connected (+15555551212)");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("validates phone number format before sending verification", async () => {
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    setupAgentPhoneSettingsPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Connect AgentPhone")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect AgentPhone"));
    const input = await screen.findByTestId("agentphone-phone-input");
    await fill(input, "555-1212");

    expect(
      screen.queryByText(
        "Enter a phone number with country code, like +1 555 555 1212.",
      ),
    ).not.toBeInTheDocument();

    fireEvent.blur(input);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Enter a phone number with country code, like +1 555 555 1212.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Send verification")).toBeDisabled();

    fireEvent.focus(input);
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Enter a phone number with country code, like +1 555 555 1212.",
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("disconnects a linked AgentPhone account", async () => {
    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    setupAgentPhoneSettingsPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-connected-indicator"),
      ).toHaveTextContent("Connected (+15555551212)");
    });

    click(screen.getByLabelText("Disconnect AgentPhone"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect AgentPhone")).toBeInTheDocument();
      expect(
        screen.queryByTestId("agentphone-connected-indicator"),
      ).not.toBeInTheDocument();
    });
  });

  it("does not render connect controls when the feature switch is off", async () => {
    detachedSetupPage({
      context,
      path: "/settings/agentphone",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByText("AgentPhone is not enabled for this workspace."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Connect AgentPhone")).toBeNull();
    });
  });
});
