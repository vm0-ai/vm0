import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
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

function connectedPersonalClaudeCodeProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
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

function dialogContaining(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Containing dialog not found");
  }
  return dialog;
}

async function findLatestClaudeCodeInput(): Promise<HTMLInputElement> {
  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  const input = inputs.at(-1);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Claude Code authorization code input not found");
  }
  return input;
}

function clickLatestByTestId(testId: string): void {
  const elements = screen.getAllByTestId(testId);
  const element = elements.at(-1);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`${testId} element not found`);
  }
  click(element);
}

function closeDialogsContainingTestId(testId: string): void {
  const dialogs = new Set(
    screen.queryAllByTestId(testId).map((input) => {
      return dialogContaining(input);
    }),
  );
  for (const dialog of dialogs) {
    if (document.body.contains(dialog)) {
      click(within(dialog).getByLabelText("Close"));
    }
  }
}

function closeClaudeCodeDialogs(): void {
  closeDialogsContainingTestId("claude-code-device-auth-code");
}

function connectButtonInRow(row: HTMLElement, label: string): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
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
    const connectButton = connectButtonInRow(
      claudeCodeRow,
      "Connect Claude Code OAuth",
    );
    click(connectButton);

    const authorizationCodeInputs = await screen.findAllByTestId(
      "claude-code-device-auth-code",
    );
    expect(authorizationCodeInputs).not.toHaveLength(0);
    expect(screen.getAllByText("Connect Claude Code")).not.toHaveLength(0);
    closeClaudeCodeDialogs();
    await waitFor(() => {
      expect(
        screen.queryAllByTestId("claude-code-device-auth-code"),
      ).toHaveLength(0);
    });
  });

  it("connects personal Claude Code after the user corrects the authorization code", async () => {
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
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ body, respond }) => {
        if (body.authorizationCode !== "claude-auth-code") {
          return respond(400, {
            error: {
              message: "Invalid Claude Code authorization code",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }
        const provider = connectedPersonalClaudeCodeProvider();
        context.mocks.data.personalModelProviders([provider]);
        return respond(200, {
          status: "complete",
          provider,
          created: true,
        });
      },
    );

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    const connectButton = connectButtonInRow(
      claudeCodeRow,
      "Connect Claude Code OAuth",
    );
    click(connectButton);

    const codeInput = await findLatestClaudeCodeInput();
    const deviceAuthDialog = dialogContaining(codeInput);
    click(
      within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"),
    );

    await waitFor(() => {
      expect(
        within(deviceAuthDialog).getByText(
          "Paste the Claude Code authorization code to continue.",
        ),
      ).toBeInTheDocument();
    });

    await fill(codeInput, "wrong-code");
    click(
      within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"),
    );

    await waitFor(() => {
      expect(
        within(deviceAuthDialog).getByText(
          "Invalid Claude Code authorization code",
        ),
      ).toBeInTheDocument();
    });

    await fill(codeInput, "claude-auth-code");
    click(
      within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"),
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
      expect(within(claudeCodeRow).getByText("Connected")).toBeInTheDocument();
    });
  });

  it("retries and closes personal Claude Code login after a start failure", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    let startAttempts = 0;
    let cancelledSessionToken: string | null = null;
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      startAttempts += 1;
      if (startAttempts === 1) {
        return respond(503, {
          error: {
            message: "Claude Code login is temporarily unavailable",
            code: "PROVIDER_UNAVAILABLE",
          },
        });
      }
      return respond(200, {
        sessionToken: "mock-personal-claude-code-retry-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.cancel,
      ({ body, respond }) => {
        cancelledSessionToken = body.sessionToken;
        return respond(200, { status: "cancelled" });
      },
    );

    await openModelSettings();

    const claudeCodeRow = await screen.findByTestId(
      "oauth-card-claude-code-oauth-token",
    );
    click(connectButtonInRow(claudeCodeRow, "Connect Claude Code OAuth"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Claude Code login is temporarily unavailable"),
      ).not.toHaveLength(0);
    });
    clickLatestByTestId("claude-code-device-auth-start");

    const codeInput = await findLatestClaudeCodeInput();
    const deviceAuthDialog = dialogContaining(codeInput);
    expect(
      within(deviceAuthDialog).getByText("Connect Claude Code"),
    ).toBeInTheDocument();

    closeClaudeCodeDialogs();

    await waitFor(() => {
      expect(cancelledSessionToken).toBe(
        "mock-personal-claude-code-retry-session",
      );
      expect(
        screen.queryAllByTestId("claude-code-device-auth-code"),
      ).toHaveLength(0);
    });
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

  it("retries and closes personal Codex login after a plan error", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.data.personalModelProviders([]);
    let startAttempts = 0;
    let cancelledSessionToken: string | null = null;
    context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
      startAttempts += 1;
      if (startAttempts === 1) {
        return respond(403, {
          error: {
            message: "Free plan rejected",
            code: "CODEX_FREE_PLAN_REJECTED",
          },
        });
      }
      return respond(200, {
        sessionToken: "mock-personal-codex-retry-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "PLAN-1234",
        expiresIn: 30,
        interval: 1,
      });
    });
    context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
      return respond(200, { status: "pending", errorMessage: null });
    });
    context.mocks.api(
      zeroCodexDeviceAuthContract.cancel,
      ({ body, respond }) => {
        cancelledSessionToken = body.sessionToken;
        return respond(200, { status: "cancelled" });
      },
    );

    await openModelSettings();

    const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
    click(connectButtonInRow(codexRow, "Connect ChatGPT (Codex)"));

    await waitFor(() => {
      expect(
        screen.getAllByText(
          "Free ChatGPT plans cannot use Codex via vm0. Upgrade to Plus or Pro and try again.",
        ),
      ).not.toHaveLength(0);
    });
    clickLatestByTestId("codex-device-auth-start");

    const deviceAuthCodes = await screen.findAllByTestId(
      "codex-device-auth-code",
    );
    const deviceAuthCode = deviceAuthCodes.at(-1);
    if (!(deviceAuthCode instanceof HTMLElement)) {
      throw new Error("Codex device auth code not found");
    }
    expect(deviceAuthCode).toHaveTextContent("PLAN-1234");
    closeDialogsContainingTestId("codex-device-auth-code");

    await waitFor(() => {
      expect(cancelledSessionToken).toBe("mock-personal-codex-retry-session");
      expect(screen.queryAllByTestId("codex-device-auth-code")).toHaveLength(0);
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
