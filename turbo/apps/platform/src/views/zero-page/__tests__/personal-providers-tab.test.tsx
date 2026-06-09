import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function stalePersonalCodexProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000301",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Personal ChatGPT",
    planType: "pro",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function connectedPersonalCodexProvider(): ModelProviderResponse {
  return {
    ...stalePersonalCodexProvider(),
    needsReconnect: false,
    lastRefreshErrorCode: null,
  };
}

function mockPersonalProvidersStory(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([stalePersonalCodexProvider()]);
  context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-personal-codex-device-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "PERS-1234",
      expiresIn: 30,
      interval: 1,
    });
  });
  context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });
}

async function openModelSettings(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=model" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Models" })).toBeInTheDocument();
  });
}

describe("personal model providers settings", () => {
  it("opens personal Claude Code login from model settings", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-personal-claude-code-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    expect(
      within(claudeCodeRow).getByText("Claude Code OAuth"),
    ).toBeInTheDocument();
    const connectButton = queryAllByRoleFast("button", claudeCodeRow).find(
      (button) => {
        return (
          button.getAttribute("aria-label") === "Connect Claude Code OAuth"
        );
      },
    );
    if (!connectButton) {
      throw new Error("Connect Claude Code OAuth button not found");
    }
    click(connectButton);

    const authorizationCodeInputs = await screen.findAllByTestId(
      "claude-code-device-auth-code",
    );
    expect(authorizationCodeInputs).not.toHaveLength(0);
    expect(screen.getAllByText("Connect Claude Code")).not.toHaveLength(0);
  });

  it("opens reconnect login from a stale personal Codex credential", async () => {
    mockPersonalProvidersStory();
    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(within(codexRow).getByText("Attention")).toBeInTheDocument();

    click(within(codexRow).getByLabelText("More options"));
    click(await screen.findByText("Replace"));

    await waitFor(() => {
      expect(screen.getAllByText("Re-connect Codex")).not.toHaveLength(0);
      const deviceAuthCodes = screen.getAllByTestId("codex-device-auth-code");
      expect(deviceAuthCodes).not.toHaveLength(0);
      for (const deviceAuthCode of deviceAuthCodes) {
        expect(deviceAuthCode).toHaveTextContent("PERS-1234");
      }
    });
  });

  it("disconnects a connected personal Codex credential", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([
      connectedPersonalCodexProvider(),
    ]);
    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    expect(within(codexRow).getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(within(codexRow).getByText("Connected")).toBeInTheDocument();

    click(within(codexRow).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(within(codexRow).queryByText("Connected")).not.toBeInTheDocument();
      expect(
        queryAllByRoleFast("button", codexRow).find((button) => {
          return button.textContent?.trim() === "Connect";
        }),
      ).toBeInTheDocument();
    });
  });
});
