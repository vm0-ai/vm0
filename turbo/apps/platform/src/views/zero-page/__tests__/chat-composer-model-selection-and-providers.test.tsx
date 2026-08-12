import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadServiceTier,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroUserModelPreferenceContract,
  type UserModelPreferenceResponse,
} from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { ZERO_RECOGNITION_MAX_FILE_BYTES } from "@vm0/api-contracts/contracts/zero-recognition";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { emitMockedClerkEvent } from "../../../__tests__/mock-auth.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies.ts";
import {
  reloadUserModelPreference$,
  userModelPreference$,
} from "../../../signals/external/user-model-preference.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import {
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
} from "../../../signals/zero-page/zero-chat-page.ts";
import { loadLeftThread$ } from "../../../signals/chat-page/chat-thread-panes.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
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
  OPENROUTER_PROVIDER_ID,
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
  composerElementFrom,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

async function navigateToChatThread(threadId: string): Promise<void> {
  const link = await waitFor(() => {
    const candidate = document.querySelector<HTMLAnchorElement>(
      `a[href="/chats/${threadId}"]`,
    );
    if (!candidate) {
      throw new Error(`Thread link not found: ${threadId}`);
    }
    return candidate;
  });
  click(link);
}

function queryFastModeOption(
  modelLabel: string,
  fastLabel = "Fast",
): HTMLElement | undefined {
  return (
    screen.queryByRole("option", {
      name: `${modelLabel} ${fastLabel}`,
    }) ?? undefined
  );
}

function findFastModeOption(
  modelLabel: string,
  fastLabel = "Fast",
): Promise<HTMLElement> {
  return waitFor(() => {
    const option = queryFastModeOption(modelLabel, fastLabel);
    if (!option) {
      throw new Error(`Fast mode option not found: ${modelLabel} ${fastLabel}`);
    }
    return option;
  });
}

function fastModeIcon(option: HTMLElement): SVGElement {
  const icon = option.querySelector<SVGElement>("svg.lucide-zap");
  if (!icon) {
    throw new Error("Fast mode icon not found");
  }
  return icon;
}

function mockBuiltInFastModel(): void {
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000911",
      model: "gpt-5.6-sol",
      modelLabel: "GPT 5.6 Sol",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
    }),
  ]);
  mockAgent();
}

describe("chat composer models", () => {
  it("keeps model resources cached across Clerk profile events", async () => {
    const policy = buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000205",
      model: "claude-fable-5",
      modelLabel: "Claude Fable 5",
      isDefault: true,
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: OPENROUTER_PROVIDER_ID,
    });
    let policiesRequestCount = 0;
    let preferenceRequestCount = 0;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(zeroModelPoliciesMainContract.list, ({ respond }) => {
      policiesRequestCount += 1;
      return respond(200, {
        policies: [policy],
        workspaceDefaultModel: policy.model,
        workspaceDefaultPolicyId: policy.id,
      });
    });
    context.mocks.api(zeroUserModelPreferenceContract.get, ({ respond }) => {
      preferenceRequestCount += 1;
      return respond(200, {
        selectedModel: null,
        serviceTier: null,
        updatedAt: null,
      });
    });
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Claude Fable 5");
    await waitFor(() => {
      expect(policiesRequestCount).toBe(1);
      expect(preferenceRequestCount).toBe(1);
    });

    await act(async () => {
      emitMockedClerkEvent();
      await context.store.get(orgModelPolicies$);
      await context.store.get(userModelPreference$);
    });

    expect(policiesRequestCount).toBe(1);
    expect(preferenceRequestCount).toBe(1);
  });

  it("shows the cached default model immediately when returning from agents", async () => {
    const policy = buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000205",
      model: "claude-fable-5",
      modelLabel: "Claude Fable 5",
      isDefault: true,
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: OPENROUTER_PROVIDER_ID,
    });
    const pendingModelRequests = context.mocks.deferred<void>();
    let blockModelRequests = false;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(
      zeroModelPoliciesMainContract.list,
      async ({ respond, withSignal }) => {
        if (blockModelRequests) {
          await withSignal(pendingModelRequests.promise);
        }
        return respond(200, {
          policies: [policy],
          workspaceDefaultModel: policy.model,
          workspaceDefaultPolicyId: policy.id,
        });
      },
    );
    context.mocks.api(
      zeroUserModelPreferenceContract.get,
      async ({ respond, withSignal }) => {
        if (blockModelRequests) {
          await withSignal(pendingModelRequests.promise);
        }
        return respond(200, {
          selectedModel: null,
          serviceTier: null,
          updatedAt: null,
        });
      },
    );
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Claude Fable 5");

    act(() => {
      context.store.set(detachedNavigateTo$, ROUTES.agents);
    });
    await screen.findByRole("heading", { name: "Agents" });

    blockModelRequests = true;

    act(() => {
      context.store.set(detachedNavigateTo$, ROUTES.agentChat, {
        pathParams: { agentId: AGENT_ID },
      });
    });

    await findComposerEditor();
    expect(
      screen.getByRole("combobox", { name: "Claude Fable 5" }),
    ).toBeInTheDocument();
  });

  it("resolves workspace, user, and thread model choices in the visible picker", async () => {
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Claude Fable 5");
  });

  it("shows user preference over workspace default", async () => {
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-8",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Claude Opus 4.8");
  });

  it("offers to make a temporary new-chat model choice the default below the composer", async () => {
    const user = userEvent.setup({ delay: null });
    let preference: UserModelPreferenceResponse = {
      selectedModel: "claude-fable-5",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    };
    const updatedModels: UserModelPreferenceResponse["selectedModel"][] = [];
    const preferenceUpdate = context.mocks.deferred<void>();

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(zeroUserModelPreferenceContract.get, ({ respond }) => {
      return respond(200, preference);
    });
    context.mocks.api(
      zeroUserModelPreferenceContract.update,
      async ({ body, respond }) => {
        updatedModels.push(body.selectedModel);
        await preferenceUpdate.promise;
        preference = {
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
          updatedAt: "2026-03-10T00:01:00Z",
        };
        return respond(200, preference);
      },
    );
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await expectComposerModel("Claude Fable 5");
    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
    expect(updatedModels).toStrictEqual([]);

    await user.click(await findComposerModel("Claude Sonnet 4.6"));
    const modelPicker = await screen.findByRole("listbox");
    expect(within(modelPicker).getByText("Models")).toBeInTheDocument();
    expect(
      within(modelPicker).queryByText(
        "Default for new chats and new automations",
      ),
    ).not.toBeInTheDocument();
    expect(within(modelPicker).getByText("Claude Fable 5")).toBeInTheDocument();
    expect(within(modelPicker).queryByText("Default")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.getByText("Temporarily switched to Claude Sonnet 4.6"),
    ).toBeInTheDocument();
    const setDefaultButton = buttonContainingText(
      "Set as default",
      document.body,
    );

    await user.click(setDefaultButton);

    await waitFor(() => {
      expect(updatedModels).toStrictEqual(["claude-sonnet-4-6"]);
    });
    expect(setDefaultButton).toHaveAttribute("aria-busy", "true");
    expect(setDefaultButton.querySelector(".animate-spin")).not.toBeNull();

    preferenceUpdate.resolve();
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    context.mocks.ably.trigger("userPreferenceChanged", {
      kinds: ["defaultModel"],
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Temporarily switched to Claude Sonnet 4.6"),
      ).not.toBeInTheDocument();
      expect(
        queryAllByRoleFast("button").some((button) => {
          return button.textContent === "Set as default";
        }),
      ).toBeFalsy();
    });
  });

  it.each([
    {
      defaultServiceTier: null,
      targetSpeed: "Fast",
      notice: "Fast mode is temporarily enabled for this run",
      expectedServiceTier: "priority" as const,
      expectedZapIcon: true,
    },
    {
      defaultServiceTier: "priority" as const,
      targetSpeed: "Standard",
      notice: "Fast mode is temporarily disabled for this run",
      expectedServiceTier: null,
      expectedZapIcon: false,
    },
  ])(
    "keeps Fast rightmost while offering to make a temporary $targetSpeed run speed the default",
    async ({
      defaultServiceTier,
      notice,
      expectedServiceTier,
      expectedZapIcon,
    }) => {
      const user = userEvent.setup({ delay: null });
      const codexProvider = buildProvider({
        id: "00000000-0000-4000-a000-000000000921",
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
      });
      let updatedPreference:
        | { selectedModel: string | null; serviceTier?: "priority" | null }
        | undefined;
      context.mocks.data.orgModelPolicies([
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000922",
          model: "gpt-5.6-sol",
          modelLabel: "GPT 5.6 Sol",
          isDefault: true,
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
        }),
      ]);
      context.mocks.data.personalModelProviders([codexProvider]);
      context.mocks.data.userModelPreference({
        selectedModel: "gpt-5.6-sol",
        serviceTier: defaultServiceTier,
        updatedAt: "2026-03-10T00:00:00Z",
      });
      context.mocks.api(
        zeroUserModelPreferenceContract.update,
        ({ body, respond }) => {
          updatedPreference = body;
          return respond(200, {
            selectedModel: body.selectedModel,
            serviceTier: body.serviceTier,
            updatedAt: "2026-03-10T00:01:00Z",
          });
        },
      );
      mockAgent();

      detachedSetupPage({
        context,
        featureSwitches: {
          [FeatureSwitchKey.CodexFastMode]: true,
          [FeatureSwitchKey.NewChatDefaultModelAction]: true,
        },
        path: `/agents/${AGENT_ID}/chat`,
      });

      const initialLabel =
        defaultServiceTier === "priority" ? "GPT 5.6 Sol Fast" : "GPT 5.6 Sol";
      const targetLabel = expectedZapIcon ? "GPT 5.6 Sol Fast" : "GPT 5.6 Sol";
      await user.click(await findComposerModel(initialLabel));
      const fastModeOption = await findFastModeOption("GPT 5.6 Sol");
      const standardModeOption = screen.getByRole("option", {
        name: "GPT 5.6 Sol",
      });
      expect(standardModeOption).toHaveClass("mr-8", "pr-8");
      expect(standardModeOption).not.toHaveClass("pr-16");
      expect(fastModeOption).toHaveClass("right-0");
      expect(fastModeOption).not.toHaveClass("right-8");
      expect(fastModeIcon(fastModeOption)).toHaveAttribute(
        "fill",
        expectedZapIcon ? "none" : "currentColor",
      );
      await user.click(fastModeOption);
      await expectComposerModel(targetLabel);
      await expect(screen.findByText(notice)).resolves.toBeInTheDocument();
      await user.click(buttonContainingText("Set as default", document.body));

      await waitFor(() => {
        expect(updatedPreference).toStrictEqual({
          selectedModel: "gpt-5.6-sol",
          serviceTier: expectedServiceTier,
        });
      });
    },
  );

  it("includes Fast in the temporary label when model and run speed change", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000919",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    let updatedPreference:
      | { selectedModel: string | null; serviceTier?: "priority" | null }
      | undefined;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000918",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000920",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    context.mocks.data.userModelPreference({
      selectedModel: "claude-fable-5",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.api(
      zeroUserModelPreferenceContract.update,
      ({ body, respond }) => {
        updatedPreference = body;
        return respond(200, {
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
          updatedAt: "2026-03-10T00:01:00Z",
        });
      },
    );
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.CodexFastMode]: true,
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findFastModeOption("GPT 5.6 Sol"));

    await expect(
      screen.findByText("Temporarily switched to GPT 5.6 Sol Fast"),
    ).resolves.toBeInTheDocument();
    await user.click(buttonContainingText("Set as default", document.body));

    await waitFor(() => {
      expect(updatedPreference).toStrictEqual({
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      });
    });
  });

  it("preserves selection-as-default behavior while the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    let updatedModel: string | null = null;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(
      zeroUserModelPreferenceContract.update,
      ({ body, respond }) => {
        updatedModel = body.selectedModel;
        return respond(200, {
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
          updatedAt: "2026-03-10T00:01:00Z",
        });
      },
    );
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: false,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await waitFor(() => {
      expect(updatedModel).toBe("claude-sonnet-4-6");
    });
    expect(
      screen.queryByText("Default for new chats and new automations"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Temporarily switched to Claude Sonnet 4.6"),
    ).not.toBeInTheDocument();
  });

  it("shows Fast details only while the Fast option is hovered", async () => {
    const user = userEvent.setup({ delay: null });

    mockBuiltInFastModel();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("GPT 5.6 Sol"));
    const fastModeOption = await findFastModeOption("GPT 5.6 Sol");
    expect(fastModeIcon(fastModeOption)).toHaveAttribute("fill", "none");
    await user.hover(fastModeOption);
    fireEvent.mouseMove(fastModeOption);
    expect(
      screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
    ).not.toBeInTheDocument();
    const fastModeTooltip = await screen.findByText(
      "Fast · 1.5× model speed · 2.5× credit usage",
      {},
      { timeout: 2000 },
    );
    expect(fastModeTooltip).toBeInTheDocument();

    await user.unhover(fastModeOption);
    await waitFor(() => {
      expect(
        screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
      ).not.toBeInTheDocument();
    });

    await user.click(fastModeOption);
    await expectComposerModel("GPT 5.6 Sol Fast");
    expect(
      screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
    ).not.toBeInTheDocument();
  });

  it("shows active Fast state and preserves exact model row selection", async () => {
    const user = userEvent.setup({ delay: null });

    mockBuiltInFastModel();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("GPT 5.6 Sol"));
    let fastModeOption = await findFastModeOption("GPT 5.6 Sol");
    await user.click(fastModeOption);
    await expectComposerModel("GPT 5.6 Sol Fast");

    await user.click(await findComposerModel("GPT 5.6 Sol Fast"));
    fastModeOption = await findFastModeOption("GPT 5.6 Sol");
    const standardOption = screen.getByRole("option", {
      name: "GPT 5.6 Sol",
    });
    expect(fastModeIcon(fastModeOption)).toHaveAttribute(
      "fill",
      "currentColor",
    );
    expect(standardOption.querySelector("svg.lucide-check")).not.toBeNull();
    expect(fastModeOption.querySelector("svg.lucide-check")).toBeNull();

    await user.hover(fastModeOption);
    fireEvent.mouseMove(fastModeOption);
    expect(
      screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
    ).not.toBeInTheDocument();
    const activeFastModeTooltip = await screen.findByText(
      "Fast · 1.5× model speed · 2.5× credit usage",
      {},
      { timeout: 2000 },
    );
    expect(activeFastModeTooltip).toBeInTheDocument();

    await user.unhover(fastModeOption);
    await waitFor(() => {
      expect(
        screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
      ).not.toBeInTheDocument();
    });

    await user.click(standardOption);
    await expectComposerModel("GPT 5.6 Sol Fast");

    await user.click(await findComposerModel("GPT 5.6 Sol Fast"));
    fastModeOption = await findFastModeOption("GPT 5.6 Sol");
    await user.click(fastModeOption);
    await expectComposerModel("GPT 5.6 Sol");

    await user.click(await findComposerModel("GPT 5.6 Sol"));
    fastModeOption = await findFastModeOption("GPT 5.6 Sol");
    expect(fastModeIcon(fastModeOption)).toHaveAttribute("fill", "none");
    await user.click(fastModeOption);
    await expectComposerModel("GPT 5.6 Sol Fast");
  });

  it("keeps a new Fast thread Fast when its optimistic state reconciles", async () => {
    const user = userEvent.setup({ delay: null });
    let sentBody:
      | {
          model?: string;
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;
    let createdBody:
      | {
          clientThreadId?: string;
          eventId?: string;
          model?: string;
          serviceTier?: ChatThreadServiceTier | null;
        }
      | undefined;
    let modelSelectionUpdateCount = 0;

    mockBuiltInFastModel();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdBody = body;
      },
      onModelSelectionUpdate: () => {
        modelSelectionUpdateCount++;
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

    await user.click(await findComposerModel("GPT 5.6 Sol"));
    await user.click(await findFastModeOption("GPT 5.6 Sol"));
    await expectComposerModel("GPT 5.6 Sol Fast");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use fast mode",
    );

    await waitFor(() => {
      expect(createdBody?.model).toBe("gpt-5.6-sol");
      expect(createdBody?.serviceTier).toBe("priority");
      expect(sentBody?.model).toBeUndefined();
      expect(sentBody?.runOptions).toStrictEqual({
        codexServiceTier: "fast",
      });
      expect(modelSelectionUpdateCount).toBe(1);
    });

    const reconciledThreadId = createdBody?.clientThreadId;
    const reconciledCreateEventId = createdBody?.eventId;
    if (
      reconciledThreadId === undefined ||
      reconciledCreateEventId === undefined
    ) {
      throw new Error("Expected the created Fast thread identifiers");
    }
    const reconciledTitle = "Reconciled Fast thread";
    const reconciledSelectedModel = createdBody?.model ?? null;
    const reconciledServiceTier = createdBody?.serviceTier ?? null;
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, {
        events: [
          {
            id: reconciledCreateEventId,
            seqId: 1,
            kind: "created",
            chatThreadId: reconciledThreadId,
            agentId: AGENT_ID,
            title: reconciledTitle,
            selectedModel: reconciledSelectedModel,
            serviceTier: reconciledServiceTier,
            computerUseHostId: null,
            cloudBrowserEnabled: false,
            createdAt: "2026-08-12T09:00:00Z",
          },
        ],
        hasMore: false,
      });
    });
    triggerAblyEvent("threadListChanged");
    await waitFor(() => {
      expect(document.title).toBe(`${reconciledTitle} | VM0`);
    });
    await expectComposerModel("GPT 5.6 Sol Fast");
  });

  it("localizes model routes, price guidance, and Codex speed controls in Portuguese", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000913",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000914",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000915",
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.CodexFastMode]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("GPT 5.6 Sol"));
    const fastModeOption = await findFastModeOption("GPT 5.6 Sol", "Rápido");
    expect(fastModeIcon(fastModeOption)).toHaveAttribute("fill", "none");
    await user.hover(fastModeOption);
    fireEvent.mouseMove(fastModeOption);
    expect(
      screen.queryByText(
        "Rápido · Velocidade do modelo 1,5× · uso de créditos 2,5×",
      ),
    ).not.toBeInTheDocument();
    const fastModeTooltip = await screen.findByText(
      "Rápido · Velocidade do modelo 1,5× · uso de créditos 2,5×",
      {},
      { timeout: 2000 },
    );
    expect(fastModeTooltip).toBeInTheDocument();

    await user.unhover(fastModeOption);
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Rápido · Velocidade do modelo 1,5× · uso de créditos 2,5×",
        ),
      ).not.toBeInTheDocument();
    });

    await user.click(fastModeOption);
    await expectComposerModel("GPT 5.6 Sol Rápido");
    expect(
      screen.queryByText(
        "Rápido · Velocidade do modelo 1,5× · uso de créditos 2,5×",
      ),
    ).not.toBeInTheDocument();

    await user.click(await findComposerModel("GPT 5.6 Sol Rápido"));
    const modelPicker = await screen.findByRole("listbox");

    await user.hover(within(modelPicker).getByText("$"));
    await expect(
      screen.findAllByText("Nível econômico para tarefas simples do dia a dia"),
    ).resolves.not.toHaveLength(0);

    await user.hover(within(modelPicker).getByText("BYOK"));
    await expect(
      screen.findAllByText("Usa seu provedor configurado"),
    ).resolves.not.toHaveLength(0);
  });

  it("remembers Codex fast mode in the user model preference", async () => {
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
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
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

    await user.click(await findComposerModel("GPT 5.6 Luna"));
    await user.click(await findFastModeOption("GPT 5.6 Luna"));
    await expectComposerModel("GPT 5.6 Luna Fast");
    act(() => {
      triggerAblyEvent("userPreferenceChanged", {
        kinds: ["defaultModel"],
      });
    });
    act(() => {
      context.store.set(resetChatPageModelSelection$);
    });

    await expectComposerModel("GPT 5.6 Luna Fast");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Remember fast mode",
    );

    await waitFor(() => {
      expect(updatedModelSelection?.modelSelection).toStrictEqual({
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "gpt-5.6-luna",
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
    context.mocks.data.userModelPreference({
      selectedModel: "gpt-5.6-terra",
      serviceTier: "priority",
      updatedAt: "2026-05-08T00:00:00.000Z",
    });

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000926",
        model: "gpt-5.6-terra",
        modelLabel: "GPT 5.6 Terra",
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
        screen.getByRole("combobox", { name: /^GPT 5\.6 Terra$/ }),
      ).toBeInTheDocument();
    });
    await user.click(await findComposerModel("GPT 5.6 Terra"));
    expect(queryFastModeOption("GPT 5.6 Terra")).toBeUndefined();
    await user.keyboard("{Escape}");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use standard mode",
    );

    await waitFor(() => {
      expect(sentBody).toBeDefined();
      expect(sentBody?.runOptions).toBeUndefined();
    });
  });

  it.each([
    {
      reason: "the feature switch is off",
      codexFastModeEnabled: false,
      model: "gpt-5.6-sol" as const,
      modelLabel: "GPT 5.6 Sol",
      defaultProviderType: "codex-oauth-token" as const,
      credentialScope: "member" as const,
    },
    {
      reason: "the selected model is not GPT 5.6",
      codexFastModeEnabled: true,
      model: "gpt-5.5" as const,
      modelLabel: "GPT 5.5",
      defaultProviderType: "vm0" as const,
      credentialScope: "org" as const,
    },
  ])(
    "drops an explicit new-thread Codex Fast tier when $reason",
    async ({
      codexFastModeEnabled,
      model,
      modelLabel,
      defaultProviderType,
      credentialScope,
    }) => {
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
          model,
          modelLabel,
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
          selectedModel: model,
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

      await user.click(await findComposerModel(modelLabel));
      expect(queryFastModeOption(modelLabel)).toBeUndefined();
      await user.keyboard("{Escape}");
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

  it("ignores the stored Codex priority default when Fast is unavailable", async () => {
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000927",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    context.mocks.data.userModelPreference({
      selectedModel: "gpt-5.6-luna",
      serviceTier: "priority",
      updatedAt: "2026-05-08T00:00:00.000Z",
    });

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000928",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000929",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
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

    await expectComposerModel("GPT 5.6 Luna");
    await waitFor(async () => {
      await expect(
        context.store.get(userModelPreference$),
      ).resolves.toStrictEqual({
        selectedModel: "gpt-5.6-luna",
        serviceTier: "priority",
        updatedAt: "2026-05-08T00:00:00.000Z",
      });
    });
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

    await user.click(await findComposerModel("GPT 5.6 Sol Fast"));
    expect(
      fastModeIcon(await findFastModeOption("GPT 5.6 Sol")),
    ).toHaveAttribute("fill", "currentColor");
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
        model: "gpt-5.6-terra",
        modelLabel: "GPT 5.6 Terra",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.6-terra",
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

    await user.click(await findComposerModel("GPT 5.6 Terra"));
    const showedFast = queryFastModeOption("GPT 5.6 Terra") !== undefined;
    await user.keyboard("{Escape}");

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

  it("keeps a hydrated Codex fast tier on a built-in route", async () => {
    const user = userEvent.setup({ delay: null });
    let sentBody:
      | {
          runOptions?: { codexServiceTier?: "fast" };
        }
      | undefined;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000930",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.6-luna",
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

    await user.click(await findComposerModel("GPT 5.6 Luna Fast"));
    expect(
      fastModeIcon(await findFastModeOption("GPT 5.6 Luna")),
    ).toHaveAttribute("fill", "currentColor");
    await user.keyboard("{Escape}");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Continue with fast mode",
    );

    await waitFor(() => {
      expect(sentBody?.runOptions).toStrictEqual({
        codexServiceTier: "fast",
      });
    });
  });

  it("reloads a reconciled thread tier before the next send", async () => {
    const user = userEvent.setup({ delay: null });
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000918",
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
        id: "00000000-0000-4000-a000-000000000919",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    const lifecycle = mockChatLifecycle(context, {
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
    await expectComposerModel("GPT 5.6 Sol Fast");

    lifecycle.setCodexServiceTier(null);
    act(() => {
      triggerAblyEvent("threadListChanged");
    });
    await expectComposerModel("GPT 5.6 Sol");
    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Continue after server reconciliation",
    );

    await waitFor(() => {
      expect(sentBody?.runOptions).toBeUndefined();
    });
  });

  it("uses each model row click as an exact Standard or Fast selection", async () => {
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
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000917",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000932",
        model: "claude-sonnet-5",
        modelLabel: "Claude Sonnet 5",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.6-sol",
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

    await user.click(await findComposerModel("GPT 5.6 Sol Fast"));
    await user.click(
      await screen.findByRole("option", { name: "GPT 5.6 Luna" }),
    );
    await expectComposerModel("GPT 5.6 Luna");

    await user.click(await findComposerModel("GPT 5.6 Luna"));
    await user.click(await findFastModeOption("GPT 5.6 Luna"));
    await expectComposerModel("GPT 5.6 Luna Fast");
    await waitFor(() => {
      expect(updatedModelSelection?.modelSelection?.selectedModel).toBe(
        "gpt-5.6-luna",
      );
      expect(updatedModelSelection?.codexServiceTier).toBe("fast");
    });

    await user.click(await findComposerModel("GPT 5.6 Luna Fast"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 5/ }),
    );
    await expectComposerModel("Claude Sonnet 5");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use standard mode",
    );

    await waitFor(() => {
      expect(updatedModelSelection?.modelSelection).toStrictEqual({
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "claude-sonnet-5",
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
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
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

    click(await findComposerModel("GPT 5.6 Luna"));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(queryFastModeOption("GPT 5.6 Luna")).toBeUndefined();
    });
  });

  it("hides Codex fast mode for non-GPT-5.6 models", async () => {
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
        model: "claude-sonnet-5",
        modelLabel: "Claude Sonnet 5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    context.mocks.data.personalModelProviders([codexProvider]);
    mockAgent();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(await findComposerModel("Claude Sonnet 5"));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(queryFastModeOption("Claude Sonnet 5")).toBeUndefined();
    });
  });

  it("keeps the agent chat model picker open while user model preference refreshes", async () => {
    const user = userEvent.setup({ delay: null });
    const pendingPreferenceReload = context.mocks.deferred<void>();
    let holdPreferenceReload = false;
    let preferenceReloadStarted = false;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(
      zeroUserModelPreferenceContract.get,
      async ({ respond, withSignal }) => {
        if (holdPreferenceReload) {
          preferenceReloadStarted = true;
          await withSignal(pendingPreferenceReload.promise);
        }
        return respond(200, {
          selectedModel: null,
          serviceTier: null,
          updatedAt: null,
        });
      },
    );
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await user.click(
      await screen.findByRole("combobox", { name: "Claude Fable 5" }),
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
        name: "Claude Fable 5",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Claude Sonnet 4\.6/ }),
    ).toBeInTheDocument();
  });

  it("shows thread override over user and workspace defaults, then remains editable", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-8",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();
    mockThread({
      selectedModel: "claude-opus-5",
      messages: [
        {
          id: "msg-user",
          role: "user",
          content: "Use GLM",
          seqId: 1,
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await screen.findByText("Use GLM");
    await user.click(await findComposerModel("Claude Opus 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
    expect(
      screen.getByRole("combobox", {
        hidden: true,
        name: "Claude Sonnet 4.6",
      }),
    ).toBeInTheDocument();
  });

  it("does not fall back to defaults when thread projection has no model", async () => {
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-8",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();
    mockThread({ selectedModel: null });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await screen.findByPlaceholderText(PLACEHOLDER);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Claude Fable 5" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Claude Opus 4.8" }),
    ).not.toBeInTheDocument();
  });

  it("edits thread override without loading user default model selection", async () => {
    const user = userEvent.setup({ delay: null });
    let preferenceRequestStarted = false;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(zeroUserModelPreferenceContract.get, ({ respond }) => {
      preferenceRequestStarted = true;
      return respond(200, {
        selectedModel: "claude-opus-4-8",
        serviceTier: null,
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });
    mockAgent();
    mockThread({
      selectedModel: "claude-opus-5",
      messages: [
        {
          id: "msg-user",
          role: "user",
          content: "Use GLM",
          seqId: 1,
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await screen.findByText("Use GLM");
    await user.click(await findComposerModel("Claude Opus 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
    expect(preferenceRequestStarted).toBeFalsy();
    expect(
      screen.queryByText("Default for new chats and new automations"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Temporarily switched to Claude Sonnet 4.6"),
    ).not.toBeInTheDocument();
  });

  it("shows limited-free-1 models and opens plans for Pro models", async () => {
    const user = userEvent.setup({ delay: null });
    mockBillingCapabilities(
      { supportByok: false, restrictedVm0Models: true },
      "limited-free-1",
    );
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000701",
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000702",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000703",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000704",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("DeepSeek V4 Flash");
    await user.click(await findComposerModel("DeepSeek V4 Flash"));

    const deepseek = await screen.findByRole("option", {
      name: /DeepSeek V4 Flash/u,
    });
    const luna = screen.getByRole("option", { name: /GPT 5\.6 Luna/u });
    expect(deepseek).not.toHaveTextContent("Pro");
    expect(luna).not.toHaveTextContent("Pro");
    expect(
      screen.getByRole("option", { name: /GPT 5\.6 Sol.*Pro/u }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("option", { name: /Claude Fable 5.*Pro/u }),
    );
    await expect(
      screen.findByRole("heading", { name: "Compare plans" }),
    ).resolves.toBeInTheDocument();
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
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: OPENROUTER_PROVIDER_ID,
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
        screen.getByRole("option", { name: /Claude Fable 5 BYOK/ }),
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
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
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
    await user.click(await findComposerModel("Claude Fable 5"));
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
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
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
      screen.findByRole("option", { name: /Claude Fable 5/ }),
    ).resolves.toBeInTheDocument();

    context.mocks.ably.trigger("billing:changed");

    await expect(
      screen.findByText("Model picker billing refresh failed"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Claude Fable 5/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading models...")).not.toBeInTheDocument();
  });

  it("lets the server reconcile a hydrated restricted thread model", async () => {
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

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
  });

  it("lets the server reconcile a hydrated BYOK thread model", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreateCount = 0;
    mockBillingCapabilities({ supportByok: false, restrictedVm0Models: false });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000309",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: OPENROUTER_PROVIDER_ID,
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-fable-5",
      onRunCreate: () => {
        runCreateCount++;
      },
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const input = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this BYOK draft");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
  });

  it("lets the server reconcile a hydrated model missing from policy", async () => {
    const user = userEvent.setup({ delay: null });
    let runCreateCount = 0;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000308",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
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

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
  });

  it("does not block an existing thread send on a policy refresh", async () => {
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
      expect(runCreateCount).toBe(1);
    });
    await user.keyboard("{Enter}");
    policyGate.resolve();

    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });
  });

  it("does not block a persisted thread selection during provider refresh", async () => {
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
        model: "claude-opus-4-8",
        modelLabel: "Claude Opus 4.8",
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-opus-4-8",
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

    await expectComposerModel("Claude Opus 4.8");
    expect(screen.queryByText("Configure model")).not.toBeInTheDocument();

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
        name: "Claude Opus 4.8",
      }),
    );
    await user.click(await screen.findByRole("option", { name: /GPT 5\.5/ }));
    await expect(
      screen.findByRole("combobox", { name: "GPT 5.5" }),
    ).resolves.toBeInTheDocument();

    expect(screen.queryByText("Configure model")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(PLACEHOLDER);
    await fill(input, "Keep this draft");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(runCreateCount).toBe(1);
    });

    providerReload.resolve();
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
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
    const warning = (await screen.findByText("Configure model")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Configure model: The selected model is not available. Configure it before sending.",
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
    const warning = (await screen.findByText("Configure model")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Configure model: The selected model is not available. Configure it before sending.",
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
        model: "claude-opus-4-8",
        modelLabel: "Claude Opus 4.8",
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
    await expectComposerModel("Claude Opus 4.8");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Configure model")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      "Configure model: The selected model is not available. Configure it before sending.",
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

  it("accepts visual attachments across composer paths for fallback-enabled text-only models", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-opus-5");
    mockAgent();
    context.mocks.upload.success({
      id: "recognition-compatible-upload",
      filename: "uploaded.png",
      contentType: "image/png",
      size: 3,
      url: "https://example.com/uploaded.png",
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await expectComposerModel("Claude Opus 5");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;

    await user.upload(
      fileInput,
      new File(["png"], "uploaded.png", { type: "image/png" }),
    );
    await expect(
      screen.findByLabelText("Open image preview for uploaded.png"),
    ).resolves.toBeInTheDocument();

    const editor = await findComposerEditor();
    fireEvent.paste(editor, {
      clipboardData: {
        getData: () => {
          return "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return new File(["jpeg"], "pasted.jpg", {
                type: "image/jpeg",
              });
            },
          },
        ],
      },
    });

    await expect(
      screen.findByLabelText("Open image preview for pasted.jpg"),
    ).resolves.toBeInTheDocument();

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return chatClipboardHtml({
              text: "Compare the restored image",
              attachments: [
                {
                  id: "restored-recognition-image",
                  url: "https://example.com/restored.png",
                  filename: "restored.png",
                  contentType: "image/png",
                  size: 42,
                },
              ],
            });
          }
          return "";
        },
        items: [],
      },
    });

    await expect(
      screen.findByLabelText("Open image preview for restored.png"),
    ).resolves.toBeInTheDocument();

    const composer = composerElementFrom(editor);
    fireEvent.drop(composer, {
      dataTransfer: {
        files: [new File(["webp"], "dropped.webp", { type: "image/webp" })],
      },
    });

    await expect(
      screen.findByLabelText("Open image preview for dropped.webp"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText(/Claude Opus 5 cannot recognize images or videos/i),
    ).not.toBeInTheDocument();
  });

  it("accepts media outside the direct recognition contract for fallback-enabled text-only models", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-opus-5");
    mockAgent();
    context.mocks.upload.success({
      id: "recognition-boundary-visual",
      filename: "uploaded-visual",
      contentType: "application/octet-stream",
      size: 5,
      url: "https://example.com/uploaded-visual",
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await expectComposerModel("Claude Opus 5");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const oversizedImage = new File(["png"], "oversized.png", {
      type: "image/png",
    });
    Object.defineProperty(oversizedImage, "size", {
      configurable: true,
      value: ZERO_RECOGNITION_MAX_FILE_BYTES + 1,
    });

    await user.upload(fileInput, [
      new File(["gif"], "animated.gif", { type: "image/gif" }),
      new File([], "empty.png", { type: "image/png" }),
      oversizedImage,
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
    ]);

    await expect(
      screen.findByLabelText("Open image preview for animated.gif"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Open image preview for empty.png"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Open image preview for oversized.png"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByLabelText("Remove clip.mp4"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText(/Claude Opus 5 cannot recognize images or videos/i),
    ).not.toBeInTheDocument();
  });

  it("keeps a non-native image after switching to a fallback-enabled text-only model", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    context.mocks.upload.success({
      id: "recognition-model-switch",
      filename: "storyboard.gif",
      contentType: "image/gif",
      size: 128,
      url: "https://example.com/storyboard.gif",
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await expectComposerModel("Claude Sonnet 4.6");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "storyboard.gif", { type: "image/gif" }),
    );

    await expect(
      screen.findByLabelText("Open image preview for storyboard.gif"),
    ).resolves.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Claude Opus 5/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open image preview for storyboard.gif"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Claude Opus 5 cannot recognize images or videos/i),
      ).not.toBeInTheDocument();
    });
  });

  it("shows agent connector access from the composer", async () => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["github"]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

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

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

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

  it("keeps connector display stable without reloading the agent on same-agent navigation", async () => {
    let agentRequestCount = 0;

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "First Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: AGENT_ID,
        title: "Second Scout thread",
      },
    ]);
    context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
      agentRequestCount += 1;
      return respond(200, {
        agentId: params.id,
        ownerId: "test-user-123",
        displayName: "Scout",
        description: null,
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
    });
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });
    context.mocks.api(zeroAgentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, { grants: [] });
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const initialConnectorButton = within(
      await screen.findByLabelText("Chat thread"),
    ).getByLabelText("Connectors");
    await waitFor(() => {
      expect(initialConnectorButton.querySelector("img")).not.toBeNull();
    });
    const settledAgentRequestCount = agentRequestCount;

    await navigateToChatThread(OTHER_AGENT_THREAD_ID);
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Chat thread")).getByText(
          "Second Scout thread",
        ),
      ).toBeInTheDocument();
    });
    expect(agentRequestCount).toBe(settledAgentRequestCount);

    const nextConnectorButton = within(
      screen.getByLabelText("Chat thread"),
    ).getByLabelText("Connectors");
    expect(nextConnectorButton.querySelector("img")).not.toBeNull();
  });

  it("keeps connector catalog and access resolved across same-agent chat navigation", async () => {
    const unexpectedReload = context.mocks.deferred<void>();
    const unexpectedCustomReload = context.mocks.deferred<void>();
    const unexpectedDiscoveryReload = context.mocks.deferred<void>();
    let authorizationRequestCount = 0;
    let customAuthorizationRequestCount = 0;
    let discoveryRequestCount = 0;
    const githubCatalogItem: PublicConnectorCatalogStatusItem = {
      slug: "github",
      label: "GitHub",
      description: "Connect GitHub",
      icon: {
        url: "https://icons.example.test/github.svg",
        invertInDarkMode: false,
      },
      category: "data-automation-infrastructure",
      generation: [],
      tags: [],
      authMethods: [
        {
          id: "oauth",
          label: "OAuth",
          description: null,
          grantKind: "auth-code",
          manualFields: [],
          startOptions: [],
        },
      ],
      permissionSummary: {
        hasPermissions: false,
        permissionCount: 0,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
      connection: {
        authMethod: "oauth",
        externalUsername: "octocat",
        externalEmail: null,
        reconnectReason: null,
      },
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: true,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: "oauth",
      connectNotice: null,
    };

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "First Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: AGENT_ID,
        title: "Second Scout thread",
      },
    ]);
    context.mocks.api(
      zeroUserConnectorsContract.get,
      async ({ respond, withSignal }) => {
        authorizationRequestCount += 1;
        if (authorizationRequestCount > 1) {
          await withSignal(unexpectedReload.promise);
        }
        return respond(200, { enabledConnectorSlugs: ["github"] });
      },
    );
    context.mocks.api(
      zeroAgentCustomConnectorsContract.get,
      async ({ respond, withSignal }) => {
        customAuthorizationRequestCount += 1;
        if (customAuthorizationRequestCount > 1) {
          await withSignal(unexpectedCustomReload.promise);
        }
        return respond(200, { grants: [] });
      },
    );
    context.mocks.api(
      zeroConnectorCatalogContract.discovery,
      async ({ respond, withSignal }) => {
        discoveryRequestCount += 1;
        if (discoveryRequestCount > 1) {
          await withSignal(unexpectedDiscoveryReload.promise);
        }
        return respond(200, {
          connectors: [githubCatalogItem],
          totalConnectorCount: 1,
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorDiscovery]: true },
    });

    const initialThread = await screen.findByLabelText("Chat thread");
    const initialConnectorButton =
      within(initialThread).getByLabelText("Connectors");
    await waitFor(() => {
      expect(initialConnectorButton.querySelector("img")).not.toBeNull();
      expect(authorizationRequestCount).toBe(1);
      expect(customAuthorizationRequestCount).toBe(1);
      expect(discoveryRequestCount).toBe(1);
    });

    await navigateToChatThread(OTHER_AGENT_THREAD_ID);
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Chat thread")).getByText(
          "Second Scout thread",
        ),
      ).toBeInTheDocument();
    });

    const nextConnectorButton = within(
      screen.getByLabelText("Chat thread"),
    ).getByLabelText("Connectors");
    click(nextConnectorButton);
    const connectorStatusStayedResolved =
      screen.queryByLabelText("Remove GitHub") !== null;
    const requestCountAfterNavigation = authorizationRequestCount;
    const customRequestCountAfterNavigation = customAuthorizationRequestCount;
    const discoveryRequestCountAfterNavigation = discoveryRequestCount;
    unexpectedReload.resolve();
    unexpectedCustomReload.resolve();
    unexpectedDiscoveryReload.resolve();

    expect(connectorStatusStayedResolved).toBeTruthy();
    expect(requestCountAfterNavigation).toBe(1);
    expect(customRequestCountAfterNavigation).toBe(1);
    expect(discoveryRequestCountAfterNavigation).toBe(1);
    expect(nextConnectorButton.querySelector("img")).not.toBeNull();
  });

  it("does not expose previous-agent connector access while navigation resolves", async () => {
    const otherAgentAuthorization = context.mocks.deferred<void>();
    const authorizationAgentIds: string[] = [];

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent({ includeOtherAgent: true });
    mockManyConnectedConnectors();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: OTHER_AGENT_ID,
        title: "Other agent thread",
      },
    ]);
    context.mocks.api(
      zeroUserConnectorsContract.get,
      async ({ params, respond, withSignal }) => {
        authorizationAgentIds.push(params.id);
        if (params.id === OTHER_AGENT_ID) {
          await withSignal(otherAgentAuthorization.promise);
          return respond(200, { enabledConnectorSlugs: ["slack"] });
        }
        return respond(200, { enabledConnectorSlugs: ["github"] });
      },
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const initialConnectorButton = within(
      await screen.findByLabelText("Chat thread"),
    ).getByLabelText("Connectors");
    await waitFor(() => {
      expect(initialConnectorButton.querySelector("img")).not.toBeNull();
    });

    act(() => {
      context.store.set(loadLeftThread$, OTHER_AGENT_THREAD_ID);
    });
    await waitFor(() => {
      expect(authorizationAgentIds).toContain(OTHER_AGENT_ID);
      expect(
        within(screen.getByLabelText("Chat thread")).getByText(
          "Other agent thread",
        ),
      ).toBeInTheDocument();
    });

    const nextConnectorButton = within(
      screen.getByLabelText("Chat thread"),
    ).getByLabelText("Connectors");
    click(nextConnectorButton);
    expect(screen.queryByLabelText("Remove GitHub")).not.toBeInTheDocument();
    expect(nextConnectorButton.querySelector("img")).toBeNull();

    otherAgentAuthorization.resolve();
    await expect(
      screen.findByLabelText("Remove Slack"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
  });

  it("deduplicates same-agent pane reads and reloads both after a mutation", async () => {
    const user = userEvent.setup({ delay: null });
    const initialAuthorization = context.mocks.deferred<void>();
    let authorizationRequestCount = 0;
    let enabledConnectorSlugs: string[] = ["slack"];
    let updatedAuthorizationAgentId: string | undefined;

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockConnectors([
      { connectorSlug: "slack", externalUsername: "launch-team" },
    ]);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "First Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: AGENT_ID,
        title: "Second Scout thread",
      },
    ]);
    context.mocks.api(
      zeroUserConnectorsContract.get,
      async ({ respond, withSignal }) => {
        authorizationRequestCount += 1;
        if (authorizationRequestCount === 1) {
          await withSignal(initialAuthorization.promise);
        }
        return respond(200, { enabledConnectorSlugs });
      },
    );
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ params, body, respond }) => {
        updatedAuthorizationAgentId = params.id;
        enabledConnectorSlugs = applyUserConnectorUpdate(
          enabledConnectorSlugs,
          body,
        );
        return respond(200, { enabledConnectorSlugs });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}?sidebar=${OTHER_AGENT_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getAllByLabelText("Chat thread")).toHaveLength(2);
    });
    const threadRegions = screen.getAllByLabelText("Chat thread");
    await waitFor(() => {
      expect(authorizationRequestCount).toBe(1);
    });

    initialAuthorization.resolve();
    const connectorButtons = threadRegions.map((thread) => {
      return within(thread).getByLabelText("Connectors");
    });
    await waitFor(() => {
      for (const button of connectorButtons) {
        expect(button.querySelector("img")).not.toBeNull();
      }
    });

    const sideConnectorButton = connectorButtons[1];
    if (!sideConnectorButton) {
      throw new Error("Side connector button not found");
    }
    await user.click(sideConnectorButton);
    await user.click(await screen.findByLabelText("Remove Slack"));

    await waitFor(() => {
      expect(updatedAuthorizationAgentId).toBe(AGENT_ID);
      expect(authorizationRequestCount).toBe(2);
      for (const button of connectorButtons) {
        expect(button.querySelector("img")).toBeNull();
      }
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
    let persistedThreadEvent: ChatThreadEvent | null = null;
    let updatedAuthorizationAgentId: string | undefined;
    let appliedPermissionAgentId: string | undefined;

    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent({ includeOtherAgent: true });
    mockConnectors([
      { connectorSlug: "slack", externalUsername: "launch-team" },
    ]);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      { id: THREAD_ID, agentId: AGENT_ID, title: "Scout thread" },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: OTHER_AGENT_ID,
        title: "Other agent thread",
      },
    ]);
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, {
        events: persistedThreadEvent ? [persistedThreadEvent] : [],
        hasMore: false,
      });
    });
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      authorizationAgentIds.push(params.id);
      return respond(200, {
        enabledConnectorSlugs: enabledByAgent.get(params.id) ?? [],
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
        const enabledConnectorSlugs = applyUserConnectorUpdate(
          enabledByAgent.get(params.id) ?? [],
          body,
        );
        enabledByAgent.set(params.id, enabledConnectorSlugs);
        return respond(200, { enabledConnectorSlugs });
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

    await waitFor(() => {
      expect(screen.getAllByLabelText("Chat thread")).toHaveLength(2);
    });
    const threadRegions = screen.getAllByLabelText("Chat thread");
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
    persistedThreadEvent = {
      id: "d0000000-0000-4000-a000-000000000099",
      seqId: 1,
      kind: "renamed",
      chatThreadId: OTHER_AGENT_THREAD_ID,
      agentId: OTHER_AGENT_ID,
      title: "Renamed other agent thread",
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-22T09:00:00.000Z",
    };
    triggerAblyEvent("threadListChanged");
    await waitFor(() => {
      expect(
        within(sideThread).getByText("Renamed other agent thread"),
      ).toBeInTheDocument();
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
    await user.click(
      await waitFor(() => {
        return buttonContainingText("Deny", dialog);
      }),
    );
    await user.click(
      await waitFor(() => {
        return buttonContainingText("Apply", dialog);
      }),
    );

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
