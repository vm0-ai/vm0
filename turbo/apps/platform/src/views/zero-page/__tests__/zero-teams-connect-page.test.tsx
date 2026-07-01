import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function setupTeamsPage(path: string): void {
  detachedSetupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.TeamsIntegration]: true },
  });
}

function teamsConnectPath(params: Record<string, string>): string {
  const searchParams = new URLSearchParams(params);
  return `/settings/teams?${searchParams.toString()}`;
}

describe("zero Teams connect page", () => {
  it("shows the connected Microsoft Teams state from the browser connect redirect", async () => {
    setupTeamsPage(
      teamsConnectPath({
        status: "connected",
        tenantId: "tenant-123",
        teamsUserId: "29:user-123",
        teamName: "Core Team",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Connected to Microsoft Teams"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/You are connected to Core Team/),
    ).toBeInTheDocument();
    expect(screen.getByText("Open Teams")).toBeInTheDocument();
    expect(screen.getByText("Back to settings")).toBeInTheDocument();
  });

  it("connects from a Teams link with tenant and user parameters", async () => {
    context.mocks.api(zeroTeamsConnectContract.getStatus, ({ respond }) => {
      return respond(200, {
        isConnected: false,
        isInstalled: true,
        isAdmin: false,
        tenantId: "tenant-123",
        tenantName: "Acme Tenant",
        teamId: "team-123",
        teamName: "Core Team",
        defaultAgentName: null,
      });
    });
    context.mocks.api(zeroTeamsConnectContract.connect, ({ respond }) => {
      return respond(200, {
        success: true,
        connectionId: "teams-conn-123",
        role: "member",
      });
    });

    setupTeamsPage(
      teamsConnectPath({
        tenantId: "tenant-123",
        teamsUserId: "29:user-123",
        displayName: "Ada Lovelace",
        teamName: "Core Team",
      }),
    );

    click(await screen.findByText("Connect"));

    await waitFor(() => {
      expect(
        screen.getByText("Connected to Microsoft Teams"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/You are connected to Core Team/),
    ).toBeInTheDocument();
  });
});
