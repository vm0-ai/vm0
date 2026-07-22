import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { reloadUserModelPreference$ } from "../../../signals/external/user-model-preference.ts";
import { touchOptimisticChatThreadSort$ } from "../../../signals/chat-page/chat-thread-event-sourcing.ts";
import { codexFastModeLocalDefault$ } from "../../../signals/zero-page/codex-fast-local-default.ts";
import {
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
} from "../../../signals/zero-page/zero-chat-page.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  AGENT_ID,
  OTHER_AGENT_ID,
  THREAD_ID,
  OTHER_AGENT_THREAD_ID,
  MOONSHOT_PROVIDER_ID,
  setCodexFastModeDefaultStorageForTest$,
  clearCodexFastModeDefaultStorageForTest$,
  applyUserConnectorUpdate,
  expectTextBefore,
  buttonContainingText,
  buildProvider,
  buildModelPolicy,
  mockOrgModelRoutes,
  billingStatus,
  mockBillingCapabilities,
  mockAgent,
  mockThread,
  mockComposerThreadSnapshot,
  mockConnectors,
  mockManyConnectedConnectors,
  mockAgentConnectorAuthorizations,
  findComposerModel,
  expectComposerModel,
  chatClipboardHtml,
  oversizedFile,
  composerElementFrom,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat composer models", () => {
  it("resolves workspace, user, and thread model choices in the visible picker", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Kimi K2.7 Code");
  });

  it("shows user preference over workspace default", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Claude Opus 4.7");
  });

  it("sends Codex fast mode as a run option from the model picker", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000912",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          model?: string;
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;
    let createdBody:
      | {
          model?: string;
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000911",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdBody = body;
      },
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(await findComposerModel("GPT 5.6 Sol"));
    const runSpeed = await screen.findByRole("group", { name: "Run speed" });
    click(buttonContainingText("Fast", runSpeed));
    await waitFor(() => {
      expect(buttonContainingText("Fast", runSpeed)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use fast mode",
    );

    await waitFor(() => {
      expect(createdBody?.model).toBe("gpt-5.6-sol");
      expect(sentBody?.model).toBeUndefined();
      expect(sentBody?.runOptions).toStrictEqual({
        codexServiceTier: "fast",
      });
    });
  });

  it("remembers Codex fast mode for new chats in the current browser account", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000923",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;
    let updatedModelSelection:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          codexServiceTier?: "fast" | null;
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000924",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();
    mockChatLifecycle(context, {
      onModelSelectionUpdate: (body) => {
        updatedModelSelection = body;
      },
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(await findComposerModel("GPT 5.5"));
    const runSpeed = await screen.findByRole("group", { name: "Run speed" });
    click(buttonContainingText("Fast", runSpeed));
    await waitFor(() => {
      expect(buttonContainingText("Fast", runSpeed)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    act(() => {
      context.store.set(resetChatPageModelSelection$);
    });

    await expectComposerModel("GPT 5.5");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Remember fast mode",
    );

    await waitFor(() => {
      expect(updatedModelSelection?.modelSelection).toStrictEqual({
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "gpt-5.5",
      });
      expect(updatedModelSelection?.codexServiceTier).toBe("fast");
      expect(sentBody?.runOptions).toStrictEqual({
        codexServiceTier: "fast",
      });
    });
  });

  it("does not apply a remembered Codex fast mode default when the switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000925",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;
    act(() => {
      context.store.set(
        setCodexFastModeDefaultStorageForTest$,
        JSON.stringify({ "test-user-123:org_default": true }),
      );
    });

    try {
      context.mocks.data.orgModelPolicies([
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000926",
          model: "gpt-5.5",
          modelLabel: "GPT 5.5",
          isDefault: true,
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
        }),
      ]);
      context.mocks.data.personalModelProviders([codexProvider]);
      mockAgent();
      mockChatLifecycle(context, {
        onRunCreate: (body) => {
          sentBody = body;
        },
      });

      detachedSetupPage({
        context,
        featureSwitches: { [FeatureSwitchKey.CodexFastMode]: false },
        path: `/agents/${AGENT_ID}/chat`,
      });

      await waitFor(() => {
        expect(
          screen.getByRole("combobox", { name: /^GPT 5\.5$/ }),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("group", { name: "Run speed" }),
        ).not.toBeInTheDocument();
      });

      await sendMessageInUI(
        user,
        screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
        "Use standard mode",
      );

      await waitFor(() => {
        expect(sentBody).toBeDefined();
        expect(sentBody?.runOptions).toBeUndefined();
      });
    } finally {
      act(() => {
        context.store.set(clearCodexFastModeDefaultStorageForTest$);
      });
    }
  });

  it.each([
    {
      reason: "the feature switch is off",
      codexFastModeEnabled: false,
      defaultProviderType: "codex-oauth-token" as const,
      credentialScope: "member" as const,
    },
    {
      reason: "the current model route is not Codex",
      codexFastModeEnabled: true,
      defaultProviderType: "vm0" as const,
      credentialScope: "org" as const,
    },
  ])(
    "drops an explicit new-thread Codex Fast tier when $reason",
    async ({ codexFastModeEnabled, defaultProviderType, credentialScope }) => {
      const user = userEvent.setup({ delay: null });
      let modelSelectionUpdateCount = 0;
      let sentBody:
        | {
            runOptions?: { codexServiceTier?: "fast" };
          }
        | undefined;
      context.mocks.data.orgModelPolicies([
        buildModelPolicy({
          id: crypto.randomUUID(),
          model: "gpt-5.5",
          modelLabel: "GPT 5.5",
          isDefault: true,
          defaultProviderType,
          credentialScope,
        }),
      ]);
      context.mocks.data.personalModelProviders(
        defaultProviderType === "codex-oauth-token"
          ? [
              buildProvider({
                id: crypto.randomUUID(),
                type: "codex-oauth-token",
                framework: "codex",
                secretName: null,
                authMethod: "auth_json",
                secretNames: ["CODEX_AUTH_JSON"],
              }),
            ]
          : [],
      );
      act(() => {
        context.store.set(setChatPageModelSelection$, {
          selectedModel: "gpt-5.5",
          codexServiceTier: "fast",
        });
      });
      mockAgent();
      mockChatLifecycle(context, {
        onModelSelectionUpdate: () => {
          modelSelectionUpdateCount++;
        },
        onRunCreate: (body) => {
          sentBody = body;
        },
      });

      detachedSetupPage({
        context,
        featureSwitches: {
          [FeatureSwitchKey.CodexFastMode]: codexFastModeEnabled,
        },
        path: `/agents/${AGENT_ID}/chat`,
      });

      const modelPicker = await findComposerModel("GPT 5.5");
      expect(within(modelPicker).queryByText("Fast")).toBeNull();
      await sendMessageInUI(
        user,
        screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
        "Send without stale Fast mode",
      );

      await waitFor(() => {
        expect(sentBody).toBeDefined();
        expect(sentBody?.runOptions).toBeUndefined();
      });
      expect(modelSelectionUpdateCount).toBe(0);
    },
  );

  it("keeps the remembered Codex fast default when Fast is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000927",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    act(() => {
      context.store.set(
        setCodexFastModeDefaultStorageForTest$,
        JSON.stringify({ "test-user-123:org_default": true }),
      );
    });

    try {
      context.mocks.data.orgModelPolicies([
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000928",
          model: "kimi-k2.7-code",
          modelLabel: "Kimi K2.7 Code",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
        }),
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000929",
          model: "gpt-5.5",
          modelLabel: "GPT 5.5",
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
        }),
      ]);
      context.mocks.data.personalModelProviders([codexProvider]);
      mockAgent();
      mockChatLifecycle(context);

      detachedSetupPage({
        context,
        featureSwitches: { [FeatureSwitchKey.CodexFastMode]: false },
        path: `/agents/${AGENT_ID}/chat`,
      });

      await user.click(await findComposerModel("Kimi K2.7 Code"));
      await user.click(await screen.findByRole("option", { name: /GPT 5\.5/ }));
      await expectComposerModel("GPT 5.5");
      await waitFor(async () => {
        await expect(
          context.store.get(codexFastModeLocalDefault$),
        ).resolves.toBeTruthy();
      });
    } finally {
      act(() => {
        context.store.set(clearCodexFastModeDefaultStorageForTest$);
      });
    }
  });

  it("keeps Codex fast mode when continuing a hydrated thread", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000913",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000914",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.6-sol",
      codexServiceTier: "fast",
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /GPT 5\.6 Sol/ }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("combobox", { name: /GPT 5\.6 Sol/ }));
    const runSpeed = await screen.findByRole("group", { name: "Run speed" });
    expect(buttonContainingText("Fast", runSpeed)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{Escape}");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Continue fast mode",
    );

    await waitFor(() => {
      expect(sentBody?.modelSelection).toBeUndefined();
      expect(sentBody?.runOptions).toStrictEqual({
        codexServiceTier: "fast",
      });
    });
  });

  it("hides a hydrated Codex fast tier when the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000923",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000924",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      codexServiceTier: "fast",
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: false },
      path: `/chats/${THREAD_ID}`,
    });

    const modelPicker = await screen.findByRole("combobox", {
      name: "GPT 5.5",
    });
    const showedFast = within(modelPicker).queryByText("Fast") !== null;

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Continue in standard mode",
    );

    await waitFor(() => {
      expect(sentBody?.runOptions).toBeUndefined();
    });
    expect(showedFast).toBeFalsy();
  });

  it("hides a hydrated Codex fast tier when the current route is not Codex", async () => {
    const user = userEvent.setup({ delay: null });
    let sentBody:
      | {
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000930",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      codexServiceTier: "fast",
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/chats/${THREAD_ID}`,
    });

    const modelPicker = await screen.findByRole("combobox", {
      name: "GPT 5.5",
    });
    expect(within(modelPicker).queryByText("Fast")).toBeNull();

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Continue without fast mode",
    );

    await waitFor(() => {
      expect(sentBody?.runOptions).toBeUndefined();
    });
  });

  it("clears Codex fast mode when switching to a non-fast model", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000915",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let sentBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;
    let updatedModelSelection:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          codexServiceTier?: "fast" | null;
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000916",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000917",
        model: "gpt-5.4",
        modelLabel: "GPT-5.4",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      codexServiceTier: "fast",
      onModelSelectionUpdate: (body) => {
        updatedModelSelection = body;
      },
      onRunCreate: (body) => {
        sentBody = body;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await screen.findByRole("combobox", { name: /GPT 5\.5/ }));
    await user.click(await screen.findByRole("option", { name: /GPT-5\.4/ }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /GPT-5\.4/ }),
      ).toBeInTheDocument();
    });

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use standard mode",
    );

    await waitFor(() => {
      expect(updatedModelSelection?.modelSelection).toStrictEqual({
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "gpt-5.4",
      });
      expect(updatedModelSelection?.codexServiceTier).toBeNull();
      expect(sentBody?.modelSelection).toBeUndefined();
      expect(sentBody?.runOptions).toBeUndefined();
    });
  });

  it("hides Codex fast mode when the feature switch is off", async () => {
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000922",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000921",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();
    mockChatLifecycle(context);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: false },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(await findComposerModel("GPT 5.5"));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Run speed" }),
      ).not.toBeInTheDocument();
    });
  });

  it("hides Codex fast mode for unsupported subscription models", async () => {
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000932",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000931",
        model: "gpt-5.4",
        modelLabel: "GPT-5.4",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(await findComposerModel("GPT-5.4"));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Run speed" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the agent chat model picker open while user model preference refreshes", async () => {
    const user = userEvent.setup({ delay: null });
    const pendingPreferenceReload = context.mocks.deferred<void>();
    let holdPreferenceReload = false;
    let preferenceReloadStarted = false;

    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.api(
      zeroUserModelPreferenceContract.get,
      async ({ respond, withSignal }) => {
        if (holdPreferenceReload) {
          preferenceReloadStarted = true;
          await withSignal(pendingPreferenceReload.promise);
        }
        return respond(200, { selectedModel: null, updatedAt: null });
      },
    );
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await user.click(
      await screen.findByRole("combobox", { name: "Kimi K2.7 Code" }),
    );
    await expect(
      screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    ).resolves.toBeInTheDocument();

    holdPreferenceReload = true;
    act(() => {
      context.store.set(reloadUserModelPreference$);
    });
    await waitFor(() => {
      expect(preferenceReloadStarted).toBeTruthy();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.getByRole("combobox", {
        hidden: true,
        name: "Kimi K2.7 Code",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Claude Sonnet 4\.6/ }),
    ).toBeInTheDocument();
  });

  it("shows thread override over user and workspace defaults, then remains editable", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();
    mockThread({
      selectedModel: "glm-5.1",
      messages: [
        {
          id: "msg-user",
          role: "user",
          content: "Use GLM",
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await screen.findByText("Use GLM");
    await user.click(await findComposerModel("GLM-5.1"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
  });

  it("does not fall back to defaults when thread projection has no model", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();
    mockThread({ selectedModel: null });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await screen.findByPlaceholderText(PLACEHOLDER);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Kimi K2.7 Code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Claude Opus 4.7" }),
    ).not.toBeInTheDocument();
  });

  it("edits thread override without loading user default model selection", async () => {
    const user = userEvent.setup({ delay: null });
    let preferenceRequestStarted = false;

    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.api(zeroUserModelPreferenceContract.get, ({ respond }) => {
      preferenceRequestStarted = true;
      return respond(200, {
        selectedModel: "claude-opus-4-7",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });
    mockAgent();
    mockThread({
      selectedModel: "glm-5.1",
      messages: [
        {
          id: "msg-user",
          role: "user",
          content: "Use GLM",
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await screen.findByText("Use GLM");
    await user.click(await findComposerModel("GLM-5.1"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
    expect(preferenceRequestStarted).toBeFalsy();
  });

  it("opens compare plans from limited-free-1 Pro composer model items", async () => {
    const user = userEvent.setup({ delay: null });
    mockBillingCapabilities({ supportByok: true, restrictedVm0Models: true });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000701",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000702",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Kimi K2.7 Code");
    await user.click(screen.getByRole("combobox", { name: "Kimi K2.7 Code" }));
    await user.click(
      await screen.findByRole("option", { name: /GPT 5\.5.*Pro/u }),
    );

    await expect(
      screen.findByRole("heading", { name: "Compare plans" }),
    ).resolves.toBeInTheDocument();
  });

  it("keeps Auto available when VM0 models and BYOK are restricted", async () => {
    const user = userEvent.setup({ delay: null });
    mockBillingCapabilities({ supportByok: false, restrictedVm0Models: true });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000703",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000704",
        model: "vm0-model",
        modelLabel: "Auto",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Kimi K2.7 Code");
    await user.click(screen.getByRole("combobox", { name: "Kimi K2.7 Code" }));
    await user.click(await screen.findByRole("option", { name: /Auto/u }));

    await expectComposerModel("Auto");
    expect(
      screen.queryByRole("heading", { name: "Compare plans" }),
    ).not.toBeInTheDocument();
  });

  it("opens the model picker directly to options and labels BYOK routes", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.orgModelProviders([]);
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000301",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000302",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        defaultProviderType: "moonshot-api-key",
        credentialScope: "org",
        modelProviderId: MOONSHOT_PROVIDER_ID,
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-sonnet-4-6",
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const modelPicker = await screen.findByRole("combobox", {
      name: "Claude Sonnet 4.6",
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(modelPicker);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /Kimi K2\.7 Code BYOK/ }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Use workspace default model")).toBeNull();
    });

    await user.keyboard("{Escape}");
    expect(modelPicker).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("restores personal models when billing refreshes after realtime subscribes", async () => {
    const user = userEvent.setup({ delay: null });
    let billingRequestCount = 0;
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      billingRequestCount += 1;
      return respond(
        200,
        billingRequestCount === 1
          ? billingStatus("limited-free-1", {
              supportByok: false,
              restrictedVm0Models: true,
            })
          : billingStatus("pro", {
              supportByok: true,
              restrictedVm0Models: false,
            }),
      );
    });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000305",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000306",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000307",
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
      }),
    ]);
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(billingRequestCount).toBeGreaterThanOrEqual(2);
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    await user.click(await findComposerModel("Kimi K2.7 Code"));
    await expect(
      screen.findByRole("option", { name: /GPT 5\.5/ }),
    ).resolves.toBeInTheDocument();
  });

  it("keeps loaded thread model options visible when billing refresh fails", async () => {
    const user = userEvent.setup({ delay: null });
    let billingRequestCount = 0;
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      billingRequestCount++;
      if (billingRequestCount === 1) {
        return respond(200, billingStatus("free"));
      }
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Model picker billing refresh failed",
        },
      });
    });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000303",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000304",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-sonnet-4-6",
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    await user.click(
      await screen.findByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await expect(
      screen.findByRole("option", { name: /Kimi K2\.7 Code/ }),
    ).resolves.toBeInTheDocument();

    context.mocks.ably.trigger("billing:changed");

    await expect(
      screen.findByText("Model picker billing refresh failed"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Kimi K2\.7 Code/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading models...")).not.toBeInTheDocument();
  });

  it("blocks a hydrated restricted model for limited-free-1 before sending", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreateCount = 0;
    mockBillingCapabilities({ supportByok: true, restrictedVm0Models: true });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000307",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this restricted draft");
    await user.keyboard("{Enter}");

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(runCreateCount).toBe(0);
    expect(input.textContent ?? "").toContain("Keep this restricted draft");
  });

  it("blocks a hydrated BYOK model for limited-free-1 before sending", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreateCount = 0;
    mockBillingCapabilities({ supportByok: false, restrictedVm0Models: false });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000309",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "moonshot-api-key",
        credentialScope: "org",
        modelProviderId: MOONSHOT_PROVIDER_ID,
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "kimi-k2.7-code",
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this BYOK draft");
    await user.keyboard("{Enter}");

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(runCreateCount).toBe(0);
    expect(input.textContent ?? "").toContain("Keep this BYOK draft");
  });

  it("blocks a hydrated model missing from the current policies", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreateCount = 0;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000308",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this stale draft");
    await user.keyboard("{Enter}");

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(runCreateCount).toBe(0);
    expect(input.textContent ?? "").toContain("Keep this stale draft");
  });

  it("blocks repeated keyboard sends while model validation is loading", async () => {
    const user = userEvent.setup({ delay: null });
    const policyGate = context.mocks.deferred<void>();
    const policy = buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000310",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
    });
    let runCreateCount = 0;

    context.mocks.api(
      zeroModelPoliciesMainContract.list,
      async ({ respond, withSignal }) => {
        await withSignal(policyGate.promise);
        return respond(200, {
          policies: [policy],
          workspaceDefaultModel: policy.model,
          workspaceDefaultPolicyId: policy.id,
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: policy.model,
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(input, "Send this once");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });
    await user.keyboard("{Enter}");

    policyGate.resolve();

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
  });

  it("revalidates the current model before sending during provider refresh", async () => {
    const user = userEvent.setup({ delay: null });
    const providerReload = context.mocks.deferred<void>();
    const claudeProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000405",
      type: "claude-code-oauth-token",
      framework: "claude-code",
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      authMethod: "oauth",
      secretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    let holdProviderReload = false;
    let providerReloadStarted = false;
    let runCreateCount = 0;

    context.mocks.api(
      zeroPersonalModelProvidersMainContract.list,
      async ({ respond, withSignal }) => {
        if (holdProviderReload) {
          providerReloadStarted = true;
          await withSignal(providerReload.promise);
        }
        return respond(200, { modelProviders: [claudeProvider] });
      },
    );
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000305",
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000306",
        model: "claude-opus-4-7",
        modelLabel: "Claude Opus 4.7",
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-opus-4-7",
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await expectComposerModel("Claude Opus 4.7");
    expect(screen.queryByText("Model Configure")).not.toBeInTheDocument();

    holdProviderReload = true;
    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }
    await user.click(accountButton);
    const accountMenu = await screen.findByRole("menu");
    await user.click(within(accountMenu).getByText("Settings"));
    const settingsDialog = await screen.findByRole("dialog", {
      name: "Settings",
    });
    await user.click(buttonContainingText("Models", settingsDialog));
    await waitFor(() => {
      expect(providerReloadStarted).toBeTruthy();
    });
    await user.click(within(settingsDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("combobox", {
        name: "Claude Opus 4.7",
      }),
    );
    await user.click(await screen.findByRole("option", { name: /GPT 5\.5/ }));
    await expect(
      screen.findByRole("combobox", { name: "GPT 5.5" }),
    ).resolves.toBeInTheDocument();

    expect(screen.queryByText("Model Configure")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this draft");
    await user.keyboard("{Enter}");
    expect(runCreateCount).toBe(0);
    expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();

    providerReload.resolve();

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(runCreateCount).toBe(0);
    expect(input.textContent ?? "").toContain("Keep this draft");
    expect(screen.getByText("Model Configure")).toBeInTheDocument();
  });

  it("blocks routed model sends until the matching device login is opened", async () => {
    const user = userEvent.setup({ delay: null });
    const codexApproval = context.mocks.deferred<void>();
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000402",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    context.mocks.browser.open(context.mocks.browser.authWindow());
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([]);
    mockAgent();
    context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-codex-device-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "ABCD-EFGH",
        expiresIn: 30,
        interval: 1,
      });
    });
    context.mocks.api(
      zeroCodexDeviceAuthContract.complete,
      async ({ respond }) => {
        await codexApproval.promise;
        context.mocks.data.personalModelProviders([codexProvider]);
        return respond(200, {
          status: "complete",
          provider: codexProvider,
          created: true,
        });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("GPT 5.5");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Model Configure: The selected model is not available. Configure it before sending.",
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("ABCD-EFGH");
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();

    click(screen.getByTestId("codex-device-auth-open"));

    await expect(
      screen.findByText("Device code copied. Waiting for approval..."),
    ).resolves.toBeInTheDocument();
    codexApproval.resolve(undefined);
    await waitFor(() => {
      expect(screen.getByText("ChatGPT connected")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Connect Codex")).not.toBeInTheDocument();
    });
  });

  it("opens reconnect login for a stale personal Codex routed model", async () => {
    const user = userEvent.setup({ delay: null });
    mockBillingCapabilities(
      { supportByok: true, restrictedVm0Models: false },
      "limited-free-1",
    );
    context.mocks.browser.open(null);
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000403",
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      }),
    ]);
    mockAgent();
    context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-stale-codex-device-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "RECO-NNECT",
        expiresIn: 30,
        interval: 1,
      });
    });
    context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
      return respond(200, { status: "pending", errorMessage: null });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("GPT 5.5");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Model Configure: The selected model is not available. Configure it before sending.",
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("RECO-NNECT");
    expect(screen.getByText("Re-connect Codex")).toBeInTheDocument();
  });

  it("completes personal Claude Code auth from a routed model blocker", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.open(null);
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "claude-opus-4-7",
        modelLabel: "Claude Opus 4.7",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([]);
    mockAgent();
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-claude-code-device-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ respond }) => {
        return respond(200, {
          status: "complete",
          provider: buildProvider({
            id: "00000000-0000-4000-a000-000000000401",
            type: "claude-code-oauth-token",
            secretName: "CLAUDE_CODE_OAUTH_TOKEN",
          }),
          created: true,
        });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("Claude Opus 4.7");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Model Configure: The selected model is not available. Configure it before sending.",
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("claude-code-device-auth-code"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Connect Claude Code")).toBeInTheDocument();

    click(screen.getByTestId("claude-code-device-auth-submit"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Paste the Claude Code authorization code to continue.",
    );

    click(screen.getByTestId("claude-code-device-auth-open"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "The approval page could not be opened.",
    );

    await fill(
      screen.getByTestId("claude-code-device-auth-code"),
      "mock-claude-code",
    );
    click(screen.getByTestId("claude-code-device-auth-submit"));

    await waitFor(() => {
      expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Connect Claude Code")).not.toBeInTheDocument();
    });
  });

  it("keeps unsupported visual files out of text-only model sends while accepting text files", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("glm-5.1");
    mockAgent();
    context.mocks.upload.success({
      id: "notes-upload",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://example.com/notes.txt",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("GLM-5.1");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;

    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );

    await expect(
      screen.findAllByText(/GLM-5\.1 cannot recognize images or videos/i),
    ).resolves.not.toHaveLength(0);
    expect(
      screen.queryByLabelText("Open image preview for screenshot.png"),
    ).not.toBeInTheDocument();

    await user.upload(
      fileInput,
      new File(["plain text"], "notes.txt", { type: "text/plain" }),
    );

    await expect(
      screen.findByLabelText("Remove notes.txt"),
    ).resolves.toBeInTheDocument();

    const editor = await findComposerEditor();
    await user.click(editor);

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "Keep this pasted caption" : "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return new File(["pasted image"], "pasted.png", {
                type: "image/png",
              });
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(editor).toHaveTextContent("Keep this pasted caption");
      expect(
        screen.queryByLabelText("Open image preview for pasted.png"),
      ).not.toBeInTheDocument();
    });

    await fill(editor, "");

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return chatClipboardHtml({
              text: "Use the copied launch brief",
              attachments: [
                {
                  id: "copied-brief",
                  url: "https://cdn.vm7.io/artifacts/test/copied/copied-brief.md",
                  filename: "copied-brief.md",
                  contentType: "text/markdown",
                  size: 42,
                },
                {
                  id: "copied-image",
                  url: "https://cdn.vm7.io/artifacts/test/copied/copied-image.png",
                  filename: "copied-image.png",
                  contentType: "image/png",
                  size: 420,
                },
              ],
            });
          }
          return "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(editor).toHaveTextContent("Use the copied launch brief");
      expect(
        screen.getByLabelText("Remove copied-brief.md"),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Open image preview for copied-image.png"),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
    });

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "Do not insert oversized paste" : "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return oversizedFile("oversized-paste.txt", "text/plain");
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("oversized-paste.txt exceeds the 1 GB limit"),
      ).toBeInTheDocument();
      expect(editor).toHaveTextContent("Use the copied launch brief");
    });

    const composer = composerElementFrom(editor);
    fireEvent.dragOver(composer);
    fireEvent.dragLeave(composer, { relatedTarget: document.body });
    fireEvent.drop(composer, {
      dataTransfer: {
        files: [
          new File(["dropped image"], "dropped.png", { type: "image/png" }),
          oversizedFile("oversized-drop.txt", "text/plain"),
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("oversized-drop.txt exceeds the 1 GB limit"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
    });
  });

  it("hides an accepted visual attachment after switching to a text-only model", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    context.mocks.upload.success({
      id: "visual-model-switch",
      filename: "storyboard.png",
      contentType: "image/png",
      size: 128,
      url: "https://example.com/storyboard.png",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Claude Sonnet 4.6");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "storyboard.png", { type: "image/png" }),
    );

    await expect(
      screen.findByLabelText("Open image preview for storyboard.png"),
    ).resolves.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await user.click(await screen.findByRole("option", { name: /GLM-5\.1/ }));

    await waitFor(() => {
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByLabelText("Open image preview for storyboard.png"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows agent connector access from the composer", async () => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["github"]);

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const composerConnectorsButton =
      within(composer).getByLabelText("Connectors");

    click(composerConnectorsButton);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Add Slack")).toBeInTheDocument();
    });
  });

  it("keeps composer connector order independent of authorization state", async () => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["slack"]);

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    click(within(composer).getByLabelText("Connectors"));

    await waitFor(() => {
      expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove Slack")).toBeInTheDocument();
      expectTextBefore("GitHub", "Slack");
    });
  });

  it("scopes connector permissions and access to each split chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const enabledByAgent = new Map<string, string[]>([
      [AGENT_ID, []],
      [OTHER_AGENT_ID, ["slack"]],
    ]);
    const authorizationAgentIds: string[] = [];
    const workflowAgentIds: string[] = [];
    const permissionGrantAgentIds: string[] = [];
    let updatedAuthorizationAgentId: string | undefined;
    let appliedPermissionAgentId: string | undefined;

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent({ includeOtherAgent: true });
    mockConnectors([{ type: "slack", externalUsername: "launch-team" }]);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: OTHER_AGENT_ID,
        title: "Other agent thread",
      },
    ]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      authorizationAgentIds.push(params.id);
      return respond(200, {
        enabledTypes: enabledByAgent.get(params.id) ?? [],
      });
    });
    context.mocks.api(
      zeroWorkflowsCollectionContract.list,
      ({ query, respond }) => {
        if (query.agentId) {
          workflowAgentIds.push(query.agentId);
        }
        return respond(200, []);
      },
    );
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ params, body, respond }) => {
        updatedAuthorizationAgentId = params.id;
        const enabledTypes = applyUserConnectorUpdate(
          enabledByAgent.get(params.id) ?? [],
          body,
        );
        enabledByAgent.set(params.id, enabledTypes);
        return respond(200, { enabledTypes });
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.list,
      ({ query, respond }) => {
        permissionGrantAgentIds.push(query.agentId);
        return respond(200, []);
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        appliedPermissionAgentId = body.agentId;
        return respond(200, []);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}?sidebar=${OTHER_AGENT_THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ComposerConnectorPermissions]: true,
      },
    });

    const threadRegions = await screen.findAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
    const sideThread = threadRegions[1];
    if (!sideThread) {
      throw new Error("Side chat thread not found");
    }
    const sideComposer = sideThread.querySelector("[data-chat-composer]");
    if (!(sideComposer instanceof HTMLElement)) {
      throw new Error("Side chat composer not found");
    }

    await waitFor(() => {
      expect(new Set(authorizationAgentIds)).toStrictEqual(
        new Set([AGENT_ID, OTHER_AGENT_ID]),
      );
      expect(new Set(workflowAgentIds)).toStrictEqual(
        new Set([AGENT_ID, OTHER_AGENT_ID]),
      );
    });
    const authorizationRequestCount = authorizationAgentIds.length;
    const workflowRequestCount = workflowAgentIds.length;
    await act(async () => {
      context.store.set(touchOptimisticChatThreadSort$, {
        id: "d0000000-0000-4000-a000-000000000099",
        threadId: OTHER_AGENT_THREAD_ID,
        agentId: OTHER_AGENT_ID,
        createdAt: "2026-07-22T09:00:00.000Z",
      });
      await Promise.resolve();
    });
    expect(authorizationAgentIds).toHaveLength(authorizationRequestCount);
    expect(workflowAgentIds).toHaveLength(workflowRequestCount);
    await user.click(within(sideComposer).getByLabelText("Connectors"));
    await user.click(
      await screen.findByLabelText("Configure Slack permissions"),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Slack permissions for Other Agent",
    });
    await waitFor(() => {
      expect(permissionGrantAgentIds).not.toHaveLength(0);
      expect(
        permissionGrantAgentIds.every((id) => {
          return id === OTHER_AGENT_ID;
        }),
      ).toBeTruthy();
    });
    await user.click(buttonContainingText("Deny", dialog));
    await user.click(buttonContainingText("Apply", dialog));

    await waitFor(() => {
      expect(appliedPermissionAgentId).toBe(OTHER_AGENT_ID);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(within(sideComposer).getByLabelText("Connectors"));
    await user.click(await screen.findByLabelText("Remove Slack"));
    await waitFor(() => {
      expect(updatedAuthorizationAgentId).toBe(OTHER_AGENT_ID);
    });
  });
});
