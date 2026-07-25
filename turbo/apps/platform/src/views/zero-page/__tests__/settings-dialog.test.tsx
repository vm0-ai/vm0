import { screen, waitFor, within } from "@testing-library/react";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function openDialog(
  role: "admin" | "member" = "admin",
  section: "debug" | "general" = "general",
): Promise<void> {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role,
  });
  context.mocks.data.orgMembers({
    slug: "test-org",
    role,
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2026-01-01T00:00:00Z",
  });
  detachedSetupPage({
    context,
    path: `/?settings=${section}`,
    ...(section === "debug"
      ? { featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true } }
      : {}),
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("settings dialog", () => {
  it("lets admins navigate workspace settings without closing the dialog", async () => {
    await openDialog("admin");

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByText("Personal")).toBeInTheDocument();
    expect(within(dialog).getByText("Workspace")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Models").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Billing & pricing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();

    const peopleTab = queryAllByRoleFast("button", dialog).find((element) => {
      return /People/u.test(element.textContent ?? "");
    });
    if (!peopleTab) {
      throw new Error("People tab not found");
    }
    click(peopleTab);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toBeInTheDocument();
    });
  });

  it("routes members away from admin-only workspace settings", async () => {
    await openDialog("member");

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
  });

  it("shows connector catalog diagnostics in Debug settings", async () => {
    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Stale")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Current")).toBeInTheDocument();
    expect(within(diagnostics).getByText("2026-07-25.1")).toBeInTheDocument();
    expect(within(diagnostics).getByText("2026-07-25.2")).toBeInTheDocument();
    expect(within(diagnostics).getByText("1.319.0")).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Cached rejection"),
    ).toBeInTheDocument();
    expect(within(diagnostics).getAllByText("Invalid artifact")).toHaveLength(
      2,
    );
    expect(within(diagnostics).getByText("github / oauth")).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Missing revoke provider"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Missing versions"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unowned secrets"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unowned variables"),
    ).toBeInTheDocument();
    expect(
      within(diagnostics).getByText("Unresolved bridge credentials"),
    ).toBeInTheDocument();
  });

  it("tolerates connector diagnostics from an older api", async () => {
    context.mocks.api(
      zeroConnectorCatalogContract.diagnostics,
      ({ respond }) => {
        return respond(200, {
          state: "stale",
          active: {
            catalogVersion: "2026-07-25.1",
            catalogDigest: `sha256:${"a".repeat(64)}`,
            activatedAt: "2026-07-25T01:00:00.000Z",
          },
          lastAttempt: {
            at: "2026-07-25T02:00:00.000Z",
            outcome: "rejected",
            failureCode: "invalid-artifact",
          },
          lastSuccessAt: "2026-07-25T01:00:00.000Z",
          filtering: {
            capabilityDigest: `sha256:${"b".repeat(64)}`,
            evaluatedAt: "2026-07-25T01:00:00.000Z",
            stale: false,
            filteredAuthMethods: [],
          },
          credentialStorage: {
            missingConnectorVersions: 0,
            unownedConnectorSecrets: 0,
            unownedConnectorVariables: 0,
            unresolvedBridgeCredentials: 0,
          },
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Unknown")).toBeInTheDocument();
    expect(
      within(diagnostics).queryByText("Rejected candidate"),
    ).not.toBeInTheDocument();
  });

  it("keeps Debug settings usable when diagnostics are unavailable", async () => {
    context.mocks.api(
      zeroConnectorCatalogContract.diagnostics,
      ({ respond }) => {
        return respond(404, {
          error: {
            message: "Connector catalog diagnostics are unavailable",
            code: "NOT_FOUND",
          },
        });
      },
    );

    await openDialog("admin", "debug");

    const diagnostics = await screen.findByRole("region", {
      name: "Connector catalog",
    });
    expect(within(diagnostics).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Build information")).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
  });
});
