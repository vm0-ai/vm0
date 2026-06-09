import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup();

describe("permission allow page", () => {
  it("lets a user grant an expiring connector permission to an agent", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";

    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId,
        ownerId: "test-user-123",
        description: null,
        displayName: "Research Bot",
        sound: null,
        avatarUrl: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`,
      user: {
        id: "test-user-123",
        fullName: "Dana Analyst",
        firstName: "Dana",
      },
      featureSwitches: {
        [FeatureSwitchKey.ExpiringPermissionGrants]: true,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          "Hey Dana, you're updating your permissions for Research Bot.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(
      screen.getByText("Access workspace analytics data"),
    ).toBeInTheDocument();
    expect(screen.getByText("admin.analytics:read")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();

    await user.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your connector permission grant has been updated"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Expires in (1 day|24 hours)/)).toBeInTheDocument();
  });
});
