import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import { setMockAgentPhoneIntegration } from "../../../mocks/handlers/api-integrations-agentphone.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();

describe("agentphone settings page", () => {
  it("redirects when the feature switch is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/settings/agentphone",
      withoutRender: true,
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: false },
    });

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/works");
    });
  });

  it("renders connected phone state", async () => {
    setMockAgentPhoneIntegration({
      linked: true,
      phoneHandle: "+15555551212",
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    detachedSetupPage({
      context,
      path: "/settings/agentphone",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("AgentPhone")).toBeInTheDocument();
      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(
        screen.getByText("+15555551212 is connected to this workspace."),
      ).toBeInTheDocument();
    });
  });

  it("normalizes phone input and starts verification", async () => {
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });

    detachedSetupPage({
      context,
      path: "/settings/agentphone",
      featureSwitches: { [FeatureSwitchKey.AgentPhoneAppUi]: true },
    });

    const input = await waitFor(() => {
      return screen.getByTestId("agentphone-phone-input");
    });
    await fill(input, "(555) 555-1212");

    await waitFor(() => {
      expect(
        screen.getByTestId("agentphone-normalized-phone"),
      ).toHaveTextContent("5555551212");
    });

    click(screen.getByText("Send verification"));

    await waitFor(() => {
      expect(
        screen.getByText("Verification text sent to 5555551212."),
      ).toBeInTheDocument();
    });
  });
});
