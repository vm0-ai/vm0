import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function staleCodexProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000201",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Acme ChatGPT",
    planType: "pro",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function mockStaleProviderStory(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.data.orgModelProviders([staleCodexProvider()]);
  context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-codex-device-session",
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "WXYZ-1234",
      expiresIn: 30,
      interval: 1,
    });
  });
  context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
}

async function openProvidersTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=providers" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Models Configuration" }),
    ).toBeInTheDocument();
  });
}

describe("organization model providers settings", () => {
  it("opens device login from a stale workspace provider banner", async () => {
    mockStaleProviderStory();
    await openProvidersTab();

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("ChatGPT session needs reconnection"),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText(
        "Your ChatGPT session expired. Re-connect to continue.",
      ),
    ).toBeInTheDocument();

    click(within(alert).getByText("Reconnect"));

    await waitFor(() => {
      expect(screen.getByText("Re-connect Codex")).toBeInTheDocument();
      expect(screen.getByTestId("codex-device-auth-code")).toHaveTextContent(
        "WXYZ-1234",
      );
    });
  });
});
