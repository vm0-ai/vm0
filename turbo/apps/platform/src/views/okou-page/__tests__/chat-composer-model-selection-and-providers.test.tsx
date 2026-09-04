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
  chatThreadImageModelContract,
  chatThreadVideoModelContract,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type ChatThreadServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { IMAGE_RECOGNITION_MAX_FILE_BYTES } from "@okouai/api-contracts/contracts/image-recognition";
import { beforeEach, describe, expect, it } from "vitest";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { emitMockedClerkEvent } from "../../../__tests__/mock-auth.ts";
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
} from "../../../signals/okou-page/chat-page.ts";
import { loadLeftThread$ } from "../../../signals/chat-page/chat-thread-panes.ts";
import { eventDrivenChatThread } from "../../../signals/chat-page/chat-thread-event-sourcing.ts";
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

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

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

/**
 * The composer carries one model trigger for every category; the Chat / Image /
 * Video split is a segment control inside the popover it opens.
 */
function findComposerModelPickerTrigger(
  root: ParentNode = document,
): Promise<HTMLElement> {
  return waitFor(() => {
    const trigger = root.querySelector<HTMLElement>('[role="combobox"]');
    if (!trigger) {
      throw new Error("Composer model picker trigger not found");
    }
    return trigger;
  });
}

function categoryTab(
  name: string,
  root: ParentNode = document,
): HTMLElement | undefined {
  return queryAllByRoleFast("radio", root).find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
}

function findCategoryTab(
  name: string,
  root: ParentNode = document,
): Promise<HTMLElement> {
  return waitFor(() => {
    const tab = categoryTab(name, root);
    if (!tab) {
      throw new Error(`${name} category tab not found`);
    }
    return tab;
  });
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

type ModelScopeLabel =
  | "Model for this chat"
  | "Image model for this chat"
  | "Video model for this chat";

function queryModelScope(label: ModelScopeLabel): HTMLElement | null {
  return screen.queryByRole("group", { name: label });
}

function queryModelScopeValue(
  label: ModelScopeLabel,
  model: string,
): HTMLElement | null {
  const scope = queryModelScope(label);
  return scope ? within(scope).queryByText(model) : null;
}

function mockBuiltInFastModel(): void {
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000911",
      model: "gpt-5.6-sol",
      modelLabel: "GPT 5.6 Sol",
      isDefault: true,
      defaultProviderType: "built-in",
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
    context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
      policiesRequestCount += 1;
      return respond(200, {
        policies: [policy],
        workspaceDefaultModel: policy.model,
        workspaceDefaultPolicyId: policy.id,
      });
    });
    context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
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
      modelPoliciesMainContract.list,
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
      userModelPreferenceContract.get,
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
    const modelPicker = await findComposerModel("Claude Fable 5");
    expect(
      Array.from(
        modelPicker.querySelectorAll<HTMLImageElement>("img"),
        (icon) => {
          return icon.width;
        },
      ),
    ).toStrictEqual([18, 16]);
  });

  it("keeps the model brand icon on the trigger beside the media categories", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread({ selectedModel: "claude-fable-5" });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const modelPicker = await findComposerModel("Claude Fable 5");
    // The category now lives inside the popover, so open it to confirm the
    // media panel resolved before reading the trigger's icons.
    await user.click(modelPicker);
    await expect(findCategoryTab("Image")).resolves.toBeInTheDocument();
    // The trigger carries the selected model's brand mark on both layouts,
    // and no mode glyph.
    expect(
      Array.from(
        modelPicker.querySelectorAll<HTMLImageElement>("img"),
        (icon) => {
          return icon.width;
        },
      ),
    ).toStrictEqual([18, 16]);
    expect(modelPicker.querySelector(".lucide-message-circle")).toBeNull();
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

  it.each([
    ["video", "defaultVideoModel"],
    ["image", "defaultImageModel"],
  ] as const)(
    "reloads the member default when the push carries the %s kind alongside an unknown kind",
    async (_media, preferenceKind) => {
      mockOrgModelRoutes("claude-fable-5");
      context.mocks.data.userModelPreference({
        selectedModel: "claude-fable-5",
        serviceTier: null,
        selectedVideoModel: null,
        selectedImageModel: null,
        updatedAt: "2026-03-10T00:00:00Z",
      });
      mockAgent();

      detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
      await expectComposerModel("Claude Fable 5");

      // A sibling session changed one media default. A future kind must not
      // prevent this bundle from recognizing that known kind and refetching.
      context.mocks.data.userModelPreference({
        selectedModel: "claude-opus-4-8",
        serviceTier: null,
        selectedVideoModel: "fal-ai/veo3.1/fast",
        selectedImageModel: "fal-ai/qwen-image",
        updatedAt: "2026-03-10T00:01:00Z",
      });
      await waitFor(() => {
        expect(
          context.mocks.ably.hasSubscription("userPreferenceChanged"),
        ).toBeTruthy();
      });
      act(() => {
        triggerAblyEvent("userPreferenceChanged", {
          kinds: [preferenceKind, "futurePreferenceKind"],
        });
      });

      await waitFor(async () => {
        await expect(
          context.store.get(userModelPreference$),
        ).resolves.toMatchObject({
          selectedModel: "claude-opus-4-8",
          selectedVideoModel: "fal-ai/veo3.1/fast",
          selectedImageModel: "fal-ai/qwen-image",
        });
      });
      await expectComposerModel("Claude Opus 4.8");
    },
  );

  it("shows a new-chat model scope card and offers it for future chats", async () => {
    const user = userEvent.setup({ delay: null });
    let preference: UserModelPreferenceResponse = {
      selectedModel: "claude-fable-5",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    };
    const updatedModels: UserModelPreferenceResponse["selectedModel"][] = [];
    const preferenceUpdate = context.mocks.deferred<void>();

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
      return respond(200, preference);
    });
    context.mocks.api(
      userModelPreferenceContract.update,
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
    // The always-present media panel replaces the "Models" section label with
    // the category switch that holds this list.
    await expect(findCategoryTab("Video")).resolves.toBeInTheDocument();
    expect(
      within(modelPicker).queryByText(
        "Default for new chats and new automations",
      ),
    ).not.toBeInTheDocument();
    expect(within(modelPicker).getByText("Claude Fable 5")).toBeInTheDocument();
    expect(within(modelPicker).queryByText("Default")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    const scopeCard = screen.getByRole("group", {
      name: "Model for this chat",
    });
    expect(
      within(scopeCard).getByText("Claude Sonnet 4.6"),
    ).toBeInTheDocument();
    expect(
      within(scopeCard).getByText("Temporarily switch to"),
    ).toBeInTheDocument();
    const useForFutureChatsButton = buttonContainingText(
      "Use this for future chats",
      scopeCard,
    );

    await user.click(useForFutureChatsButton);

    await waitFor(() => {
      expect(updatedModels).toStrictEqual(["claude-sonnet-4-6"]);
    });
    expect(useForFutureChatsButton).toHaveAttribute("aria-busy", "true");
    expect(
      useForFutureChatsButton.querySelector(".animate-spin"),
    ).not.toBeNull();

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
      expect(queryModelScope("Model for this chat")).toBeNull();
      expect(
        queryAllByRoleFast("button").some((button) => {
          return button.textContent === "Use this for future chats";
        }),
      ).toBeFalsy();
    });
  });

  it.each([
    {
      defaultServiceTier: null,
      targetSpeed: "Fast",
      scopedModel: "GPT 5.6 Sol Fast",
      expectedServiceTier: "priority" as const,
      expectedZapIcon: true,
    },
    {
      defaultServiceTier: "priority" as const,
      targetSpeed: "Standard",
      scopedModel: "GPT 5.6 Sol Standard",
      expectedServiceTier: null,
      expectedZapIcon: false,
    },
  ])(
    "offers to make a temporary $targetSpeed run speed the default",
    async ({
      defaultServiceTier,
      scopedModel,
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
        userModelPreferenceContract.update,
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
      expect(fastModeIcon(fastModeOption)).toHaveAttribute(
        "fill",
        expectedZapIcon ? "none" : "currentColor",
      );
      await user.click(fastModeOption);
      await expectComposerModel(targetLabel);
      await waitFor(() => {
        expect(
          queryModelScopeValue("Model for this chat", scopedModel),
        ).toBeInTheDocument();
      });
      await user.click(
        buttonContainingText("Use this for future chats", document.body),
      );

      await waitFor(() => {
        expect(updatedPreference).toStrictEqual({
          selectedModel: "gpt-5.6-sol",
          serviceTier: expectedServiceTier,
        });
      });
    },
  );

  it("includes Fast in the scoped model when model and run speed change", async () => {
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
        defaultProviderType: "built-in",
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
      userModelPreferenceContract.update,
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

    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "GPT 5.6 Sol Fast"),
      ).toBeInTheDocument();
    });
    await user.click(
      buttonContainingText("Use this for future chats", document.body),
    );

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
      userModelPreferenceContract.update,
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
    expect(queryModelScope("Model for this chat")).toBeNull();
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
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      return respond(200, {
        events: [
          {
            id: reconciledCreateEventId,
            seqId: (query.sinceSeqId ?? 0) + 1,
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
    changeChatThreadList();
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
        defaultProviderType: "built-in",
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
      defaultProviderType: "built-in" as const,
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
        defaultProviderType: "built-in",
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
        defaultProviderType: "built-in",
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
      changeChatThreadList();
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
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000932",
        model: "claude-sonnet-5",
        modelLabel: "Claude Sonnet 5",
        defaultProviderType: "built-in",
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
        defaultProviderType: "built-in",
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
      userModelPreferenceContract.get,
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

  it("keeps the agent chat model picker open while feature switches hydrate", async () => {
    const user = userEvent.setup({ delay: null });
    const featureSwitchRequestStarted = context.mocks.deferred<void>();
    const releaseFeatureSwitchResponse = context.mocks.deferred<void>();

    context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
      featureSwitchRequestStarted.resolve();
      await releaseFeatureSwitchResponse.promise;
      return respond(200, { switches: {}, effectiveSwitches: {} });
    });
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();

    detachedSetupPage({
      context,
      cachedFeatureSwitches: {},
      path: `/agents/${AGENT_ID}/chat`,
    });

    await featureSwitchRequestStarted.promise;
    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await user.click(
      await screen.findByRole("combobox", { name: "Claude Fable 5" }),
    );
    await expect(
      screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    ).resolves.toBeInTheDocument();

    releaseFeatureSwitchResponse.resolve();

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /Claude Sonnet 4\.6/ }),
      ).toBeInTheDocument();
    });
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

  it("edits thread override without offering the new-chat default actions", async () => {
    const user = userEvent.setup({ delay: null });

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
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
    expect(
      screen.queryByText("Default for new chats and new automations"),
    ).not.toBeInTheDocument();
    expect(queryModelScope("Model for this chat")).toBeNull();
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
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000702",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000703",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000704",
        model: "claude-fable-5-1",
        modelLabel: "Claude Fable 5.1",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000705",
        model: "gpt-6-astra",
        modelLabel: "GPT 6 Astra",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

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
    expect(
      screen.getByRole("option", { name: /GPT 6 Astra.*Pro/u }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("option", { name: /Claude Fable 5\.1.*Pro/u }),
    );
    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
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
        defaultProviderType: "built-in",
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
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
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
        defaultProviderType: "built-in",
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
      expect(billingRequestCount).toBeGreaterThanOrEqual(1);
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    context.mocks.ably.trigger("billing:changed");
    await waitFor(() => {
      expect(billingRequestCount).toBeGreaterThanOrEqual(2);
    });
    await user.click(await findComposerModel("Claude Fable 5"));
    await expect(
      screen.findByRole("option", { name: /GPT 5\.5/ }),
    ).resolves.toBeInTheDocument();
  });

  it("keeps loaded thread model options visible when billing refresh fails", async () => {
    const user = userEvent.setup({ delay: null });
    let billingRequestCount = 0;
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
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
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000304",
        model: "claude-fable-5",
        modelLabel: "Claude Fable 5",
        defaultProviderType: "built-in",
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
        defaultProviderType: "built-in",
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
        defaultProviderType: "built-in",
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
      defaultProviderType: "built-in",
      credentialScope: "org",
    });
    let runCreateCount = 0;

    context.mocks.api(
      modelPoliciesMainContract.list,
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
      personalModelProvidersMainContract.list,
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
    const accountButton = await waitFor(() => {
      return buttonByLabel("Alex Rivera");
    });
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
    context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
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
    context.mocks.api(codexDeviceAuthContract.complete, async ({ respond }) => {
      await codexApproval.promise;
      context.mocks.data.personalModelProviders([codexProvider]);
      return respond(200, {
        status: "complete",
        provider: codexProvider,
        created: true,
      });
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

  it("reconnects the active personal Codex account from a new chat", async () => {
    const user = userEvent.setup({ delay: null });
    let startBody: unknown;
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
        id: "00000000-0000-4000-a000-000000000402",
        modelProviderId: "00000000-0000-4000-a000-000000000400",
        isActive: false,
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
      }),
      buildProvider({
        id: "00000000-0000-4000-a000-000000000403",
        modelProviderId: "00000000-0000-4000-a000-000000000400",
        isActive: true,
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
    context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
      startBody = body;
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
    context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
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
    expect(startBody).toStrictEqual({
      scope: "personal",
      mode: "reconnect",
      modelProviderId: "00000000-0000-4000-a000-000000000403",
    });
  });

  it("reconnects personal Claude Code from an existing chat", async () => {
    const user = userEvent.setup({ delay: null });
    let startBody: unknown;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "claude-opus-4-8",
        modelLabel: "Claude Opus 4.8",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000404",
        type: "claude-code-oauth-token",
        framework: "claude-code",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      }),
    ]);
    mockAgent();
    mockThread({ selectedModel: "claude-opus-4-8" });
    context.mocks.api(
      claudeCodeDeviceAuthContract.start,
      ({ body, respond }) => {
        startBody = body;
        return respond(200, {
          sessionToken: "mock-stale-claude-code-device-session",
          type: "claude-code",
          status: "pending",
          scope: "personal",
          browserUrl: "https://claude.ai/oauth/authorize",
          expiresIn: 30,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });
    await expectComposerModel("Claude Opus 4.8");

    await screen.findByText("Configure model");
    await user.click(buttonContainingText("Configure model"));

    await expect(
      screen.findByTestId("claude-code-device-auth-code"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Re-connect Claude Code")).toBeInTheDocument();
    expect(startBody).toStrictEqual({
      scope: "personal",
      mode: "reconnect",
      modelProviderId: "00000000-0000-4000-a000-000000000404",
    });
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
    context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-claude-code-device-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(claudeCodeDeviceAuthContract.complete, ({ respond }) => {
      return respond(200, {
        status: "complete",
        provider: buildProvider({
          id: "00000000-0000-4000-a000-000000000401",
          type: "claude-code-oauth-token",
          secretName: "CLAUDE_CODE_OAUTH_TOKEN",
        }),
        created: true,
      });
    });

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
      value: IMAGE_RECOGNITION_MAX_FILE_BYTES + 1,
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

  it("limits the composer trigger to three icons while keeping Cloud browser visible", async () => {
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["github", "slack", "asana"]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const connectorButton = () => {
      return within(composer).getByLabelText("Connectors");
    };
    click(connectorButton());

    await waitFor(() => {
      expect(
        connectorButton().querySelectorAll(":scope > span > span"),
      ).toHaveLength(3);
      expect(
        connectorButton().querySelector(".lucide-globe"),
      ).toBeInTheDocument();
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
    context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
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
        visibility: "public",
      });
    });
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, { grants: [] });
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const initialThread = await screen.findByLabelText("Chat thread");
    click(within(initialThread).getByLabelText("Connectors"));
    await waitFor(() => {
      expect(
        within(initialThread).getByLabelText("Connectors").querySelector("img"),
      ).not.toBeNull();
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

    const nextThread = screen.getByLabelText("Chat thread");
    click(within(nextThread).getByLabelText("Connectors"));
    await waitFor(() => {
      expect(
        within(nextThread).getByLabelText("Connectors").querySelector("img"),
      ).not.toBeNull();
    });
    expect(agentRequestCount).toBe(settledAgentRequestCount);
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
      userConnectorsContract.get,
      async ({ respond, withSignal }) => {
        authorizationRequestCount += 1;
        if (authorizationRequestCount > 1) {
          await withSignal(unexpectedReload.promise);
        }
        return respond(200, { enabledConnectorSlugs: ["github"] });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.get,
      async ({ respond, withSignal }) => {
        customAuthorizationRequestCount += 1;
        if (customAuthorizationRequestCount > 1) {
          await withSignal(unexpectedCustomReload.promise);
        }
        return respond(200, { grants: [] });
      },
    );
    context.mocks.api(
      connectorCatalogContract.discovery,
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
    });

    const initialThread = await screen.findByLabelText("Chat thread");
    click(within(initialThread).getByLabelText("Connectors"));
    await waitFor(() => {
      expect(
        within(initialThread).getByLabelText("Connectors").querySelector("img"),
      ).not.toBeNull();
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

    const nextThread = screen.getByLabelText("Chat thread");
    click(within(nextThread).getByLabelText("Connectors"));
    await expect(
      screen.findByLabelText("Remove GitHub"),
    ).resolves.toBeInTheDocument();
    const requestCountAfterNavigation = authorizationRequestCount;
    const customRequestCountAfterNavigation = customAuthorizationRequestCount;
    const discoveryRequestCountAfterNavigation = discoveryRequestCount;
    unexpectedReload.resolve();
    unexpectedCustomReload.resolve();
    unexpectedDiscoveryReload.resolve();

    expect(requestCountAfterNavigation).toBe(1);
    expect(customRequestCountAfterNavigation).toBe(1);
    expect(discoveryRequestCountAfterNavigation).toBe(1);
    expect(
      within(nextThread).getByLabelText("Connectors").querySelector("img"),
    ).not.toBeNull();
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
      userConnectorsContract.get,
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

    const initialThread = await screen.findByLabelText("Chat thread");
    click(within(initialThread).getByLabelText("Connectors"));
    await waitFor(() => {
      expect(
        within(initialThread).getByLabelText("Connectors").querySelector("img"),
      ).not.toBeNull();
    });

    act(() => {
      context.store.set(loadLeftThread$, OTHER_AGENT_THREAD_ID);
    });
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Chat thread")).getByText(
          "Other agent thread",
        ),
      ).toBeInTheDocument();
    });

    const nextThread = screen.getByLabelText("Chat thread");
    click(within(nextThread).getByLabelText("Connectors"));
    await waitFor(() => {
      expect(authorizationAgentIds).toContain(OTHER_AGENT_ID);
    });
    expect(screen.queryByLabelText("Remove GitHub")).not.toBeInTheDocument();
    expect(
      within(nextThread).getByLabelText("Connectors").querySelector("img"),
    ).toBeNull();

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
      userConnectorsContract.get,
      async ({ respond, withSignal }) => {
        authorizationRequestCount += 1;
        if (authorizationRequestCount === 1) {
          await withSignal(initialAuthorization.promise);
        }
        return respond(200, { enabledConnectorSlugs });
      },
    );
    context.mocks.api(
      userConnectorsContract.update,
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
    const mainThread = threadRegions[0];
    const sideThread = threadRegions[1];
    if (!mainThread || !sideThread) {
      throw new Error("Split chat threads not found");
    }
    const connectorButtonFor = (thread: HTMLElement) => {
      return within(thread).getByLabelText("Connectors");
    };

    await user.click(connectorButtonFor(mainThread));
    await user.click(connectorButtonFor(mainThread));
    await user.click(connectorButtonFor(sideThread));
    await waitFor(() => {
      expect(authorizationRequestCount).toBe(1);
    });

    initialAuthorization.resolve();
    await waitFor(() => {
      for (const thread of threadRegions) {
        expect(connectorButtonFor(thread).querySelector("img")).not.toBeNull();
      }
    });

    await user.click(await screen.findByLabelText("Remove Slack"));

    await waitFor(() => {
      expect(updatedAuthorizationAgentId).toBe(AGENT_ID);
      expect(authorizationRequestCount).toBe(2);
      for (const thread of threadRegions) {
        expect(connectorButtonFor(thread).querySelector("img")).toBeNull();
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
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      authorizationAgentIds.push(params.id);
      return respond(200, {
        enabledConnectorSlugs: enabledByAgent.get(params.id) ?? [],
      });
    });
    context.mocks.api(
      workflowsCollectionContract.list,
      ({ query, respond }) => {
        if (query.agentId) {
          workflowAgentIds.push(query.agentId);
        }
        return respond(200, []);
      },
    );
    context.mocks.api(
      userConnectorsContract.update,
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
      userPermissionGrantsContract.list,
      ({ query, respond }) => {
        permissionGrantAgentIds.push(query.agentId);
        return respond(200, []);
      },
    );
    context.mocks.api(
      userPermissionGrantsContract.apply,
      ({ body, respond }) => {
        appliedPermissionAgentId = body.agentId;
        return respond(200, []);
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
    const mainThread = threadRegions[0];
    const sideThread = threadRegions[1];
    if (!mainThread || !sideThread) {
      throw new Error("Split chat threads not found");
    }
    const sideComposer = sideThread.querySelector("[data-chat-composer]");
    if (!(sideComposer instanceof HTMLElement)) {
      throw new Error("Side chat composer not found");
    }

    await user.click(within(mainThread).getByLabelText("Connectors"));
    await user.click(within(mainThread).getByLabelText("Connectors"));
    await user.click(within(sideComposer).getByLabelText("Connectors"));
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
    changeChatThreadList();
    await waitFor(() => {
      expect(
        within(sideThread).getByText("Renamed other agent thread"),
      ).toBeInTheDocument();
    });
    expect(authorizationAgentIds).toHaveLength(authorizationRequestCount);
    expect(workflowAgentIds).toHaveLength(workflowRequestCount);
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

describe("chat composer image model", () => {
  function imageCategoryTab(
    root: ParentNode = document,
  ): HTMLElement | undefined {
    return categoryTab("Image", root);
  }

  function findImageCategoryTab(
    root: ParentNode = document,
  ): Promise<HTMLElement> {
    return waitFor(() => {
      const tab = imageCategoryTab(root);
      if (!tab) {
        throw new Error("Image category tab not found");
      }
      return tab;
    });
  }

  /**
   * Opens the single composer entry point and switches to the image models.
   * `root` scopes the trigger only -- the popover is portalled to the body.
   */
  async function openImageModels(
    user: ReturnType<typeof userEvent.setup>,
    root: ParentNode = document,
  ): Promise<HTMLElement> {
    await user.click(await findComposerModelPickerTrigger(root));
    const tab = await findImageCategoryTab();
    await user.click(tab);
    return tab;
  }

  // Matched on the row's own label rather than its text, which also carries
  // the price tier badge.
  function mediaPanelButton(label: string): HTMLElement | undefined {
    return queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === label;
    });
  }

  /** The row's text is its label followed by the price tier badge. */
  function mediaPanelPriceTier(label: string): string | undefined {
    const text = mediaPanelButton(label)
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    return text?.slice(label.length).trim();
  }

  function findMediaPanelButton(label: string): Promise<HTMLElement> {
    return waitFor(() => {
      const button = mediaPanelButton(label);
      if (!button) {
        throw new Error(`${label} button not found`);
      }
      return button;
    });
  }

  /**
   * The composer no longer prints the image model, so the selection is read
   * from the open panel's pressed row.
   */
  function selectedImageModelLabel(
    root: ParentNode = document,
  ): string | undefined {
    // `aria-current` marks the selected row -- the same cue the checkmark gives
    // sighted users.
    const selected = root.querySelector("[aria-current='true']");
    return selected?.getAttribute("aria-label") ?? undefined;
  }

  function imageModelBrandIcon(label: string): Element {
    const icon = mediaPanelButton(label)?.firstElementChild;
    if (!icon) {
      throw new Error(`${label} brand icon not found`);
    }
    return icon;
  }

  it("uses the live member image default for an untouched new chat", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    const initialPreference: UserModelPreferenceResponse = {
      selectedModel: null,
      serviceTier: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      updatedAt: "2026-08-18T00:00:00Z",
    };
    let createdImageModel: string | undefined;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference(initialPreference);
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdImageModel = body.imageModel;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await openImageModels(user);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("Nano Banana 2");
    });

    context.mocks.data.userModelPreference({
      ...initialPreference,
      selectedImageModel: "gpt-image-2",
      updatedAt: "2026-08-18T00:01:00Z",
    });
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    act(() => {
      triggerAblyEvent("userPreferenceChanged", {
        kinds: ["defaultImageModel"],
      });
    });
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("GPT Image 2");
    });
    await user.keyboard("{Escape}");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use my current image default",
    );

    // Untouched: the thread is created unpinned so it follows the live member
    // default (already reflected in the button above) instead of freezing it.
    await waitFor(() => {
      expect(createdImageModel).toBeUndefined();
    });
  });

  it("keeps a mobile image pick temporary, pins it, and resets after send", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    const updates: UpdateUserModelPreferenceRequest[] = [];
    let createdThreadId: string | undefined;
    let createdImageModel: string | undefined;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        return respond(200, {
          ...body,
          updatedAt: "2026-08-18T00:01:00Z",
        });
      },
    );
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdThreadId = body.clientThreadId;
        createdImageModel = body.imageModel;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findCategoryTab("Image"));
    expect(queryModelScope("Image model for this chat")).toBeNull();
    await user.click(await findMediaPanelButton("GPT Image 2"));

    await waitFor(() => {
      expect(
        queryModelScopeValue("Image model for this chat", "GPT Image 2"),
      ).toBeInTheDocument();
    });
    expect(updates).toStrictEqual([]);

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use my temporary image choice",
    );

    await waitFor(() => {
      expect(createdThreadId).toBeDefined();
      expect(createdImageModel).toBe("gpt-image-2");
    });
    if (!createdThreadId) {
      throw new Error("Created thread id not captured");
    }
    const optimisticThreadId = createdThreadId;
    await waitFor(() => {
      expect(
        context.store.get(eventDrivenChatThread(optimisticThreadId)),
      ).toMatchObject({ selectedImageModel: "gpt-image-2" });
    });

    act(() => {
      context.store.set(detachedNavigateTo$, ROUTES.agentChat, {
        pathParams: { agentId: AGENT_ID },
      });
    });
    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findCategoryTab("Image"));
    await expect(
      findMediaPanelButton("Nano Banana 2"),
    ).resolves.toHaveAttribute("aria-pressed", "true");
    expect(updates).toStrictEqual([]);
  });

  it("writes an image pick immediately when the default action is off", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    const updates: UpdateUserModelPreferenceRequest[] = [];
    let createdImageModel: string | undefined;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        return respond(200, {
          ...body,
          updatedAt: "2026-08-18T00:01:00Z",
        });
      },
    );
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdImageModel = body.imageModel;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await openImageModels(user);
    await user.click(await findMediaPanelButton("Nano Banana 2"));
    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "fal-ai/nano-banana-2",
        },
      ]);
    });

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Persist and pin my image choice",
    );
    await waitFor(() => {
      expect(createdImageModel).toBe("fal-ai/nano-banana-2");
    });
  });

  it("sets only the image default from a fresh member preference", async () => {
    const user = userEvent.setup({ delay: null });
    const updateGate = context.mocks.deferred<void>();
    const updates: UpdateUserModelPreferenceRequest[] = [];
    context.mocks.browser.matchMedia(true);
    let stored: UserModelPreferenceResponse = {
      selectedModel: "claude-fable-5",
      serviceTier: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-18T00:00:00Z",
    };

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
      return respond(200, stored);
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      async ({ body, respond, withSignal }) => {
        updates.push(body);
        await withSignal(updateGate.promise);
        stored = {
          ...stored,
          ...body,
          updatedAt: "2026-08-18T00:02:00Z",
        };
        return respond(200, stored);
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

    await openImageModels(user);
    await user.click(await findMediaPanelButton("GPT Image 2"));
    expect(updates).toStrictEqual([]);
    await waitFor(() => {
      expect(
        queryModelScopeValue("Image model for this chat", "GPT Image 2"),
      ).toBeInTheDocument();
    });

    stored = {
      ...stored,
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
      selectedVideoModel: "fal-ai/veo3.1/fast",
      updatedAt: "2026-08-18T00:01:00Z",
    };
    const useForFutureChats = buttonContainingText(
      "Use this for future chats",
      document.body,
    );
    await user.click(useForFutureChats);

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          selectedModel: "gpt-5.6-sol",
          serviceTier: "priority",
          selectedImageModel: "gpt-image-2",
        },
      ]);
      expect(useForFutureChats).toBeDisabled();
      expect(useForFutureChats).toHaveAttribute("aria-busy", "true");
    });
    fireEvent.click(useForFutureChats);
    expect(updates).toHaveLength(1);
    updateGate.resolve();

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    act(() => {
      triggerAblyEvent("userPreferenceChanged", {
        kinds: ["defaultImageModel"],
      });
    });
    await waitFor(() => {
      expect(queryModelScope("Image model for this chat")).toBeNull();
    });
  });

  it("shows only the active Chat, Image, or Video scope card", async () => {
    const user = userEvent.setup({ delay: null });
    const updates: UpdateUserModelPreferenceRequest[] = [];
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-fable-5",
      serviceTier: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        return respond(200, {
          ...body,
          updatedAt: "2026-08-18T00:01:00Z",
        });
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

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });

    await openImageModels(user);
    await user.click(await findMediaPanelButton("GPT Image 2"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Image model for this chat", "GPT Image 2"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Model for this chat")).toBeNull();

    // Switching category is enough to re-point the composer, so the card
    // follows the tab even before a model in it is picked.
    await user.click(await findComposerModelPickerTrigger());
    await user.click(await findCategoryTab("Video"));
    await waitFor(() => {
      expect(queryModelScope("Image model for this chat")).toBeNull();
    });
    await user.click(await findMediaPanelButton("Veo 3.1 fast"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Image model for this chat")).toBeNull();

    await user.click(await findComposerModelPickerTrigger());
    await user.click(await findCategoryTab("Image"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Image model for this chat", "GPT Image 2"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Video model for this chat")).toBeNull();

    await user.click(await findCategoryTab("Video"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Image model for this chat")).toBeNull();

    await user.click(await findCategoryTab("Chat"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Image model for this chat")).toBeNull();
    expect(queryModelScope("Video model for this chat")).toBeNull();
    expect(updates).toStrictEqual([]);
  });

  it("shows the effective member default and pins an image model optimistically", async () => {
    const user = userEvent.setup({ delay: null });
    const updateGate = context.mocks.deferred<void>();
    const updates: { threadId: string; model: string | null }[] = [];
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedVideoModel: null,
      selectedImageModel: "fal-ai/nano-banana-2",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    mockAgent();
    mockThread({
      selectedModel: "claude-fable-5",
      selectedImageModel: null,
    });
    context.mocks.api(
      chatThreadImageModelContract.update,
      async ({ params, body, respond, withSignal }) => {
        updates.push({ threadId: params.id, model: body.model });
        await withSignal(updateGate.promise);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const imageTab = await openImageModels(user);

    expect(imageTab).toHaveAttribute("aria-checked", "true");
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("Nano Banana 2");
    });
    const listbox = screen.getByRole("listbox");
    // Superseded and secondary variants stay generatable by alias but are no
    // longer offered as a choice here.
    expect(within(listbox).queryByText("Flux Pro v1.1")).toBeNull();
    expect(within(listbox).queryByText("Flux Pro v1.1 Ultra")).toBeNull();
    expect(within(listbox).queryByText("Seedream 5 Lite")).toBeNull();
    expect(within(listbox).queryByText("Qwen Image")).toBeNull();
    // Nano Banana 2 Lite is the exception: it is the cheaper way into the same
    // family, so it gets its own row.
    expect(mediaPanelButton("Nano Banana 2 Lite")).toBeInTheDocument();
    // Every row states what one image costs relative to the others.
    expect(mediaPanelPriceTier("Ideogram 4")).toBe("$");
    expect(mediaPanelPriceTier("GPT Image 1")).toBe("$$");
    expect(mediaPanelPriceTier("Nano Banana 2 Lite")).toBe("$$");
    expect(mediaPanelPriceTier("Nano Banana 2")).toBe("$$$");
    const openAiIcon = imageModelBrandIcon("GPT Image 2").outerHTML;
    expect(openAiIcon).toContain("openai");
    expect(imageModelBrandIcon("GPT Image 1").outerHTML).toBe(openAiIcon);
    expect(within(listbox).getByText("FLUX.2 Pro")).toBeInTheDocument();
    expect(within(listbox).getByText("Ideogram 4")).toBeInTheDocument();
    const fluxIcon = imageModelBrandIcon("FLUX.2 Pro").outerHTML;
    const nanoBananaIcon = imageModelBrandIcon("Nano Banana 2").outerHTML;
    expect(nanoBananaIcon).toContain("#f94543");
    expect(
      new Set([
        openAiIcon,
        fluxIcon,
        imageModelBrandIcon("Seedream 5 Pro").outerHTML,
        nanoBananaIcon,
      ]).size,
    ).toBe(4);
    expect(within(listbox).queryByText(/birefnet/i)).not.toBeInTheDocument();
    expect(
      within(listbox).queryByText(/clarity upscaler/i),
    ).not.toBeInTheDocument();
    expect(within(listbox).queryByText("BYOK")).not.toBeInTheDocument();
    expect(
      within(listbox).queryByText(/aspect ratio/i),
    ).not.toBeInTheDocument();

    await user.click(await findMediaPanelButton("GPT Image 1"));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          threadId: THREAD_ID,
          model: "gpt-image-1",
        },
      ]);
    });
    await openImageModels(user);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("GPT Image 1");
    });
    expect(mediaPanelButton("GPT Image 1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mediaPanelButton("Nano Banana 2")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    updateGate.resolve();
  });

  it("selects the one model each family offers", async () => {
    const user = userEvent.setup({ delay: null });
    const updates: { threadId: string; model: string | null }[] = [];
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread({
      selectedModel: "claude-fable-5",
      selectedImageModel: "gpt-image-2",
    });
    context.mocks.api(
      chatThreadImageModelContract.update,
      ({ params, body, respond }) => {
        updates.push({ threadId: params.id, model: body.model });
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // Each family is one row naming the exact model it pins, so picking it is
    // a single click with no variant step in between.
    await openImageModels(user);
    await user.click(await findMediaPanelButton("Seedream 5 Pro"));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        { threadId: THREAD_ID, model: "dola-seedream-5-0-pro-260628" },
      ]);
    });
    // Any click closes the popover, so the follow-up read reopens it.
    await openImageModels(user);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("Seedream 5 Pro");
    });

    await user.click(await findMediaPanelButton("FLUX.2 Pro"));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        { threadId: THREAD_ID, model: "dola-seedream-5-0-pro-260628" },
        { threadId: THREAD_ID, model: "fal-ai/flux-2-pro" },
      ]);
    });
    await openImageModels(user);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("FLUX.2 Pro");
    });
    expect(mediaPanelButton("Seedream 5 Pro")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows no selection when the pinned model is no longer offered", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    // Seedream 4 keeps working everywhere else, so a thread pinned to it before
    // it left the picker is a state the panel still has to render.
    mockThread({
      selectedModel: "claude-fable-5",
      selectedImageModel: "fal-ai/bytedance/seedream/v4/text-to-image",
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await openImageModels(user);
    await waitFor(() => {
      expect(mediaPanelButton("Seedream 5 Pro")).toBeInTheDocument();
    });
    const listbox = screen.getByRole("listbox");
    // Nothing claims the pin, so no row is current rather than one of the
    // offered models carrying a stale highlight.
    expect(selectedImageModelLabel()).toBeUndefined();
    expect(listbox.querySelector("[aria-current='true']")).toBeNull();
  });

  it("switches category from the same strip on mobile", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread({
      selectedModel: "claude-fable-5",
      selectedImageModel: "gpt-image-2",
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));

    // Mobile gets the same three tabs as desktop, not a root menu of rows.
    await expect(findCategoryTab("Chat")).resolves.toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(categoryTab("Image")).toBeInTheDocument();
    expect(categoryTab("Video")).toBeInTheDocument();

    await user.click(await findCategoryTab("Image"));

    await expect(findMediaPanelButton("GPT Image 2")).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mediaPanelButton("Seedream 5 Pro")).toBeInTheDocument();

    await user.click(await findCategoryTab("Chat"));

    expect(mediaPanelButton("GPT Image 2")).toBeUndefined();
    await expect(findCategoryTab("Chat")).resolves.toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps image model pins independent across split chat composers", async () => {
    const user = userEvent.setup({ delay: null });
    const updates: { threadId: string; model: string | null }[] = [];
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    mockComposerThreadSnapshot([
      {
        id: THREAD_ID,
        agentId: AGENT_ID,
        title: "First image thread",
        selectedModel: "claude-fable-5",
        selectedImageModel: "gpt-image-2",
      },
      {
        id: OTHER_AGENT_THREAD_ID,
        agentId: AGENT_ID,
        title: "Second image thread",
        selectedModel: "claude-fable-5",
        selectedImageModel: "fal-ai/nano-banana-2",
      },
    ]);
    context.mocks.api(
      chatThreadImageModelContract.update,
      ({ params, body, respond }) => {
        updates.push({ threadId: params.id, model: body.model });
        return respond(204);
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
    const firstThread = threadRegions[0];
    const secondThread = threadRegions[1];
    if (!firstThread || !secondThread) {
      throw new Error("Split chat threads not found");
    }
    // Each composer owns a popover, so the two pins are read one at a time.
    await openImageModels(user, firstThread);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("GPT Image 2");
    });
    await user.click(await findMediaPanelButton("Nano Banana 2"));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          threadId: THREAD_ID,
          model: "fal-ai/nano-banana-2",
        },
      ]);
    });
    await openImageModels(user, firstThread);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("Nano Banana 2");
    });
    await user.keyboard("{Escape}");

    await openImageModels(user, secondThread);
    await waitFor(() => {
      expect(selectedImageModelLabel()).toBe("Nano Banana 2");
    });
  });
});

describe("chat composer video model", () => {
  function videoCategoryTab(): HTMLElement | undefined {
    return categoryTab("Video");
  }

  /** Opens the single composer entry point and switches to the video models. */
  async function openVideoModels(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<HTMLElement> {
    await user.click(await findComposerModelPickerTrigger());
    const tab = await findCategoryTab("Video");
    await user.click(tab);
    return tab;
  }

  /**
   * The composer no longer prints the video model, so the selection is read
   * from the open panel's pressed row.
   */
  function selectedVideoModelLabel(): string | undefined {
    const row = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-pressed") === "true";
    });
    return row?.getAttribute("aria-label") ?? undefined;
  }

  // Matched on the row's own label rather than its text, which also carries
  // the price tier badge.
  function videoPanelButton(label: string): HTMLElement | undefined {
    return queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === label;
    });
  }

  /** The row's text is its label followed by the price tier badge. */
  function videoPanelPriceTier(label: string): string | undefined {
    const text = videoPanelButton(label)
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    return text?.slice(label.length).trim();
  }

  function findVideoPanelButton(label: string): Promise<HTMLElement> {
    return waitFor(() => {
      const button = videoPanelButton(label);
      if (!button) {
        throw new Error(`${label} button not found`);
      }
      return button;
    });
  }

  function mockVideoModelThread(selectedVideoModel: string | null): {
    readonly bodies: { model: string | null }[];
  } {
    const bodies: { model: string | null }[] = [];
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockThread({ selectedModel: "claude-fable-5", selectedVideoModel });
    context.mocks.api(
      chatThreadVideoModelContract.update,
      ({ body, respond }) => {
        bodies.push({ model: body.model });
        return respond(204);
      },
    );
    return { bodies };
  }

  it("uses the live member default for an untouched new chat", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    const initialPreference: UserModelPreferenceResponse = {
      selectedModel: null,
      serviceTier: null,
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-14T00:00:00Z",
    };
    let createdVideoModel: string | undefined;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference(initialPreference);
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdVideoModel = body.videoModel;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findCategoryTab("Video"));
    await expect(findVideoPanelButton("MiniMax H3")).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );

    context.mocks.data.userModelPreference({
      ...initialPreference,
      selectedVideoModel: "fal-ai/veo3.1/fast",
      updatedAt: "2026-08-14T00:01:00Z",
    });
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    act(() => {
      triggerAblyEvent("userPreferenceChanged", {
        kinds: ["defaultVideoModel"],
      });
    });
    await expect(findVideoPanelButton("Veo 3.1 fast")).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.keyboard("{Escape}");
    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Use my current video default",
    );

    // Untouched: the thread is created unpinned so it follows the live member
    // default (already reflected in the panel above) instead of freezing it.
    await waitFor(() => {
      expect(createdVideoModel).toBeUndefined();
    });
  });

  it("writes a landing selection to the member default and new thread", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    const updates: {
      selectedModel: string | null;
      serviceTier: ChatThreadServiceTier | null;
      selectedVideoModel?: string | null;
    }[] = [];
    let createdVideoModel: string | undefined;

    mockOrgModelRoutes("claude-fable-5");
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-14T00:00:00Z",
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        return respond(200, {
          ...body,
          updatedAt: "2026-08-14T00:01:00Z",
        });
      },
    );
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate: (body) => {
        createdVideoModel = body.videoModel;
      },
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findCategoryTab("Video"));
    await user.click(await findVideoPanelButton("Veo 3.1 fast"));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          selectedModel: null,
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      ]);
    });

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Pin my selected video model",
    );

    await waitFor(() => {
      expect(createdVideoModel).toBe("fal-ai/veo3.1/fast");
    });
  });

  it("pins a video model on the thread from the model picker", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    const { bodies } = mockVideoModelThread(null);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const videoTab = await openVideoModels(user);
    expect(videoTab).toHaveAttribute("aria-checked", "true");

    // Every public catalog model is offered, with no plan or provider filter.
    await expect(
      findVideoPanelButton("Seedance 2.5"),
    ).resolves.toBeInTheDocument();
    expect(videoPanelButton("Veo 3.1 fast")).toBeInTheDocument();
    expect(videoPanelButton("Kling v3 4K")).toBeInTheDocument();
    expect(videoPanelButton("MiniMax H3")).toBeInTheDocument();
    // Seedance 2.0 is one row for the Standard model; its Fast and Mini
    // siblings stay generatable by alias but are no longer offered here.
    expect(videoPanelButton("Seedance 2.0")).toBeInTheDocument();
    expect(videoPanelButton("Seedance 2.0 fast")).toBeUndefined();
    expect(videoPanelButton("Seedance 2.0 Mini")).toBeUndefined();
    // An untouched thread follows the system default, and the row for the model
    // its runs would use is the one marked as selected.
    expect(selectedVideoModelLabel()).toBe("Seedance 2.0");
    // Every row states what one clip costs relative to the others.
    expect(videoPanelPriceTier("Seedance 1.5 pro")).toBe("$");
    expect(videoPanelPriceTier("MiniMax H3")).toBe("$$");
    expect(videoPanelPriceTier("Seedance 2.5")).toBe("$$$");
    expect(videoPanelPriceTier("Kling v3 4K")).toBe("$$$$");

    await user.click(await findVideoPanelButton("Veo 3.1 fast"));

    await waitFor(() => {
      expect(bodies).toStrictEqual([{ model: "fal-ai/veo3.1/fast" }]);
    });
    // Choosing closes the popover. Desktop reopens on the category it was left
    // on, and the strip is what walks back to the chat models.
    await waitFor(() => {
      expect(videoPanelButton("Veo 3.1 fast")).toBeUndefined();
    });
    await user.click(await findComposerModel("Claude Fable 5"));
    await expect(findCategoryTab("Video")).resolves.toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(await findCategoryTab("Chat"));
    await expect(
      screen.findByRole("option", { name: /Claude Fable 5/ }),
    ).resolves.toBeInTheDocument();
  });

  it("switches category inside one popover opened from a single trigger", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    mockVideoModelThread(null);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // The composer carries exactly one model control, and it names the chat
    // model -- no image or video control sits beside it.
    const chatModelButton = await findComposerModel("Claude Fable 5");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(chatModelButton).toHaveAttribute("aria-expanded", "false");
    // The trigger names the model and nothing else -- no mode glyph, no
    // category word.
    expect(chatModelButton.querySelector(".lucide-message-circle")).toBeNull();
    expect(chatModelButton).toHaveTextContent("Claude Fable 5");
    expect(chatModelButton).not.toHaveTextContent("·");
    expect(chatModelButton).not.toHaveTextContent("Chat");
    expect(videoCategoryTab()).toBeUndefined();

    await user.click(chatModelButton);

    await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ });
    expect(chatModelButton).toHaveAttribute("aria-expanded", "true");
    // Both media categories the composer offers get a tab.
    await expect(findCategoryTab("Image")).resolves.toBeInTheDocument();

    // Switching category swaps the list without closing the popover.
    await user.click(await findCategoryTab("Video"));

    await expect(findVideoPanelButton("Seedance 2.5")).resolves.toBeVisible();
    expect(chatModelButton).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("option", { name: /Claude Sonnet 4\.6/ }),
    ).not.toBeInTheDocument();

    await user.click(await findCategoryTab("Chat"));

    await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ });
    expect(videoPanelButton("Seedance 2.5")).toBeUndefined();
    expect(chatModelButton).toHaveAttribute("aria-expanded", "true");

    // The same trigger closes it.
    await user.click(chatModelButton);
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /Claude Sonnet 4\.6/ }),
      ).not.toBeInTheDocument();
    });
    expect(chatModelButton).toHaveAttribute("aria-expanded", "false");
  });

  it("pins the visible fallback model to the current thread", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    const { bodies } = mockVideoModelThread("MiniMax-H3");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    // Both media categories get a tab, on mobile too.
    await expect(findCategoryTab("Image")).resolves.toBeInTheDocument();
    await user.click(await findCategoryTab("Video"));
    expect(videoPanelButton("MiniMax H3")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(await findCategoryTab("Chat"));
    expect(videoPanelButton("MiniMax H3")).toBeUndefined();
    await user.click(await findCategoryTab("Video"));

    await user.click(await findVideoPanelButton("Seedance 2.0"));

    await waitFor(() => {
      expect(bodies).toStrictEqual([{ model: "dreamina-seedance-2-0-260128" }]);
    });
  });

  it("checks the resolved member default when the thread has no pin", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(false);
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedVideoModel: "fal-ai/veo3.1/fast",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockVideoModelThread(null);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(await findCategoryTab("Video"));

    await expect(findVideoPanelButton("Veo 3.1 fast")).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sends the video parameters chosen on the composer chip", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    let runOptions: ChatRunOptionsRequest | undefined;
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-fable-5",
      onRunCreate(body) {
        runOptions = body.runOptions;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // Chat mode owns the composer until the video control is chosen.
    await screen.findByPlaceholderText(PLACEHOLDER);
    expect(screen.queryByLabelText(/^Video options /)).not.toBeInTheDocument();

    await openVideoModels(user);

    // Seedance 2.0 is the system default, and the chip states what that model
    // would use before anything is touched.
    const chip = await screen.findByLabelText(
      "Video options 16:9 \u00b7 8s \u00b7 720p",
    );
    await user.click(chip);
    await user.click(
      within(
        await screen.findByRole("radiogroup", { name: "Ratio" }),
      ).getByRole("radio", { name: "9:16" }),
    );
    await user.click(
      within(
        await screen.findByRole("radiogroup", { name: "Resolution" }),
      ).getByRole("radio", { name: "480p" }),
    );
    await screen.findByLabelText("Video options 9:16 \u00b7 8s \u00b7 480p");
    await user.keyboard("{Escape}");

    await sendMessageInUI(
      user,
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Make me a clip",
    );

    // Only what the user moved off the model's default travels with the send,
    // and it travels as a run option rather than as persisted state.
    await waitFor(() => {
      expect(runOptions).toStrictEqual({
        video: { aspectRatio: "9:16", resolution: "480p" },
      });
    });
  });

  it("offers the pinned model's own values on the composer chip", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.matchMedia(true);
    mockVideoModelThread("MiniMax-H3");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await openVideoModels(user);

    // MiniMax H3 accepts neither 720p nor 1080p, so the chip reads its own
    // default instead and the panel never offers a value it would reject.
    const chip = await screen.findByLabelText(
      "Video options 16:9 \u00b7 8s \u00b7 2k",
    );
    await user.click(chip);
    const resolutions = await screen.findByRole("radiogroup", {
      name: "Resolution",
    });
    expect(
      within(resolutions)
        .getAllByRole("radio")
        .map((option) => {
          return option.textContent;
        }),
    ).toStrictEqual(["768p", "2k"]);
    expect(
      within(resolutions).queryByRole("radio", { name: "720p" }),
    ).not.toBeInTheDocument();
  });

  function mockNewChatVideoDefaultAction(
    preference: UserModelPreferenceResponse,
  ): {
    readonly updates: UpdateUserModelPreferenceRequest[];
  } {
    const updates: UpdateUserModelPreferenceRequest[] = [];
    let stored = preference;
    context.mocks.browser.matchMedia(true);
    mockOrgModelRoutes("claude-fable-5");
    context.mocks.api(userModelPreferenceContract.get, ({ respond }) => {
      return respond(200, stored);
    });
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        updates.push(body);
        stored = { ...stored, ...body, updatedAt: "2026-08-14T00:01:00Z" };
        return respond(200, stored);
      },
    );
    mockAgent();
    return { updates };
  }

  it("keeps a new-chat video pick temporary and offers it as the default", async () => {
    const user = userEvent.setup({ delay: null });
    const { updates } = mockNewChatVideoDefaultAction({
      selectedModel: null,
      serviceTier: null,
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-14T00:00:00Z",
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    // Entering video mode with the member default still selected says nothing.
    // The first category switch also opens the video list.
    await openVideoModels(user);
    expect(queryModelScope("Video model for this chat")).toBeNull();

    await user.click(await findVideoPanelButton("Veo 3.1 fast"));

    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    // Picking alone must not touch the member default any more.
    expect(updates).toStrictEqual([]);

    await user.click(
      buttonContainingText("Use this for future chats", document.body),
    );

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          // The run model is untouched, so the stored null is repeated rather
          // than pinning the workspace default onto the member.
          selectedModel: null,
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      ]);
    });

    // The write is reflected through the realtime topic, like the run model.
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    act(() => {
      triggerAblyEvent("userPreferenceChanged", {
        kinds: ["defaultVideoModel"],
      });
    });
    await waitFor(() => {
      expect(queryModelScope("Video model for this chat")).toBeNull();
    });
  });

  it("shows only the scope card for the model mode the composer is in", async () => {
    const user = userEvent.setup({ delay: null });
    const { updates } = mockNewChatVideoDefaultAction({
      selectedModel: "claude-fable-5",
      serviceTier: null,
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-14T00:00:00Z",
    });
    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });

    // Video category, video model still on the member default: nothing pending.
    const videoTab = await openVideoModels(user);
    expect(videoTab).toHaveAttribute("aria-checked", "true");
    await waitFor(() => {
      expect(queryModelScope("Model for this chat")).toBeNull();
    });
    expect(queryModelScope("Video model for this chat")).toBeNull();

    await user.click(await findVideoPanelButton("Veo 3.1 fast"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Model for this chat")).toBeNull();

    // Back to the chat tab: the run-model card returns, the video one leaves.
    await user.click(await findComposerModelPickerTrigger());
    await user.click(await findCategoryTab("Chat"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Video model for this chat")).toBeNull();

    // And back again — still one at a time, still the current category's.
    await user.click(await findCategoryTab("Video"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    expect(queryModelScope("Model for this chat")).toBeNull();

    // Setting the default in video mode writes the video model only.
    await user.click(
      buttonContainingText("Use this for future chats", document.body),
    );

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          selectedModel: "claude-fable-5",
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      ]);
    });
  });

  it("keeps a just-written run model when the video default follows it", async () => {
    const user = userEvent.setup({ delay: null });
    const { updates } = mockNewChatVideoDefaultAction({
      selectedModel: "claude-fable-5",
      serviceTier: null,
      selectedVideoModel: "MiniMax-H3",
      updatedAt: "2026-08-14T00:00:00Z",
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.NewChatDefaultModelAction]: true,
      },
      path: `/agents/${AGENT_ID}/chat`,
    });

    await user.click(await findComposerModel("Claude Fable 5"));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await waitFor(() => {
      expect(
        queryModelScopeValue("Model for this chat", "Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });
    await user.click(
      buttonContainingText("Use this for future chats", document.body),
    );
    await waitFor(() => {
      expect(updates).toHaveLength(1);
    });

    // No `userPreferenceChanged` push is delivered, so the cached preference
    // still holds the pre-write run model. The video write must not resend it.
    await openVideoModels(user);
    await user.click(await findVideoPanelButton("Veo 3.1 fast"));
    await waitFor(() => {
      expect(
        queryModelScopeValue("Video model for this chat", "Veo 3.1 Fast"),
      ).toBeInTheDocument();
    });
    await user.click(
      buttonContainingText("Use this for future chats", document.body),
    );

    await waitFor(() => {
      expect(updates).toStrictEqual([
        { selectedModel: "claude-sonnet-4-6", serviceTier: null },
        {
          selectedModel: "claude-sonnet-4-6",
          serviceTier: null,
          selectedVideoModel: "fal-ai/veo3.1/fast",
        },
      ]);
    });
  });
});
