import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockAgentPhoneIntegration } from "../../../mocks/handlers/api-integrations-agentphone.ts";

const context = testContext();

describe("agentphone settings page", () => {
  it("shows AgentPhone controls when the app UI switch is enabled", async () => {
    setMockAgentPhoneIntegration({
      linked: false,
      agentPhoneNumber: "+19039853128",
      configured: true,
    });
    detachedSetupPage({
      context,
      path: "/settings/agentphone",
      featureSwitches: {
        [FeatureSwitchKey.AgentPhoneAppUi]: true,
        [FeatureSwitchKey.AgentPhoneWorksControls]: false,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "AgentPhone" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Connect AgentPhone")).toBeInTheDocument();
    });
  });

  it("hides AgentPhone controls when the app UI switch is disabled", async () => {
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
