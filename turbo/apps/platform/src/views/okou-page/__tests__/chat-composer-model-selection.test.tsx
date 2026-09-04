import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
  getCanonicalModelDisplayName,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const POLICY_DATE = "2026-08-12T09:00:00.000Z";

interface PolicyOptions {
  readonly default?: boolean;
  readonly providerType?: ModelProviderType;
  readonly credentialScope?: "member" | "org";
}

function modelPolicy(
  model: SupportedRunModel,
  index: number,
  options: PolicyOptions = {},
): OrgModelPolicy {
  const providerType = options.providerType ?? "built-in";
  const credentialScope = options.credentialScope ?? "org";
  return {
    id: `e1000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    model,
    modelLabel: getCanonicalModelDisplayName(model),
    isDefault: options.default ?? false,
    defaultProviderType: providerType,
    credentialScope,
    modelProviderId:
      credentialScope === "member"
        ? `e2000000-0000-4000-a000-${String(index).padStart(12, "0")}`
        : null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: POLICY_DATE,
    updatedAt: POLICY_DATE,
  };
}

function configurePolicies(
  models: readonly SupportedRunModel[],
  defaultModel: SupportedRunModel,
): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index) => {
      return modelPolicy(model, index + 1, {
        default: model === defaultModel,
      });
    }),
  );
}

function preference(
  selectedModel: SupportedRunModel,
  serviceTier: "priority" | null = null,
): UserModelPreferenceResponse {
  return {
    selectedModel,
    serviceTier,
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: POLICY_DATE,
  };
}

function installNewChat(
  models: readonly SupportedRunModel[],
  selectedModel: SupportedRunModel,
): void {
  installRunChat({ selectedModel });
  configurePolicies(models, models[0] ?? selectedModel);
  context.mocks.data.userModelPreference(preference(selectedModel));
}

async function modelPicker(name: string): Promise<HTMLElement> {
  return await screen.findByRole("combobox", { name });
}

async function readyComposer(): Promise<HTMLElement> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toBeVisible();
  return composer;
}

async function chooseModel(
  user: ReturnType<typeof userEvent.setup>,
  currentLabel: string,
  optionName: string | RegExp,
): Promise<void> {
  await user.click(await modelPicker(currentLabel));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button ${name} was not visible`);
  }
  return button;
}

function limitedFreeBillingStatus(): BillingStatusResponse {
  return {
    tier: "limited-free-1",
    supportByok: false,
    restrictedVm0Models: true,
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

test("Choose Standard or Fast Codex execution", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.NewChatDefaultModelAction]: true,
    },
  });

  await readyComposer();
  await user.click(await modelPicker("GPT 5.6 Sol"));
  const fastOption = await screen.findByRole("option", {
    name: "GPT 5.6 Sol Fast",
  });
  await user.hover(fastOption);
  await expect(
    screen.findByText("Fast · 1.5× model speed · 2.5× credit usage"),
  ).resolves.toBeVisible();
  await user.unhover(fastOption);
  await waitFor(() => {
    expect(
      screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
    ).not.toBeInTheDocument();
  });

  await user.click(fastOption);
  await expect(modelPicker("GPT 5.6 Sol Fast")).resolves.toBeVisible();

  await user.click(await modelPicker("GPT 5.6 Sol Fast"));
  await user.click(
    await screen.findByRole("option", { name: "GPT 5.6 Sol Fast" }),
  );
  await expect(modelPicker("GPT 5.6 Sol")).resolves.toBeVisible();

  await chooseModel(user, "GPT 5.6 Sol", "GPT 5.6 Luna");
  await expect(modelPicker("GPT 5.6 Luna")).resolves.toBeVisible();
});

test("Make a temporary Codex speed the default", async () => {
  const user = userEvent.setup({ delay: null });
  const updateGate = createDeferredPromise<void>(context.signal);
  const responsePrepared = createDeferredPromise<void>(context.signal);
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond }) => {
      update = body;
      await updateGate.promise;
      const nextPreference = preference("gpt-5.6-sol", "priority");
      context.mocks.data.userModelPreference(nextPreference);
      responsePrepared.resolve(undefined);
      return respond(200, nextPreference);
    },
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.NewChatDefaultModelAction]: true,
    },
  });

  await readyComposer();
  await chooseModel(user, "GPT 5.6 Sol", "GPT 5.6 Sol Fast");
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent("Temporarily switch to GPT 5.6 Sol Fast");
  const futureChats = buttonNamed("Use this for future chats", scopeCard);

  click(futureChats);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    expect(futureChats).toHaveAttribute("aria-busy", "true");
  });

  updateGate.resolve(undefined);
  await responsePrepared.promise;
  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(
      screen.queryByRole("group", { name: "Model for this chat" }),
    ).not.toBeInTheDocument();
  });
  await expect(modelPicker("GPT 5.6 Sol Fast")).resolves.toBeVisible();
});

test("Make a new-chat model choice the default immediately", async () => {
  const user = userEvent.setup({ delay: null });
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["claude-fable-5", "claude-sonnet-4-6"], "claude-fable-5");
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    update = body;
    const nextPreference = preference("claude-sonnet-4-6");
    context.mocks.data.userModelPreference(nextPreference);
    return respond(200, nextPreference);
  });

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.NewChatDefaultModelAction]: false,
    },
  });

  await readyComposer();
  await chooseModel(user, "Claude Fable 5", /^Claude Sonnet 4\.6/iu);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
    });
  });
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Temporarily choose a model for a new chat", async () => {
  const user = userEvent.setup({ delay: null });
  const updateGate = createDeferredPromise<void>(context.signal);
  const responsePrepared = createDeferredPromise<void>(context.signal);
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["claude-fable-5", "claude-sonnet-4-6"], "claude-fable-5");
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond }) => {
      update = body;
      await updateGate.promise;
      const nextPreference = preference("claude-sonnet-4-6");
      context.mocks.data.userModelPreference(nextPreference);
      responsePrepared.resolve(undefined);
      return respond(200, nextPreference);
    },
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.NewChatDefaultModelAction]: true,
    },
  });

  await readyComposer();
  await chooseModel(user, "Claude Fable 5", /^Claude Sonnet 4\.6/iu);
  expect(update).toBeUndefined();
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent(
    "Temporarily switch to Claude Sonnet 4.6",
  );
  const futureChats = buttonNamed("Use this for future chats", scopeCard);

  click(futureChats);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
    });
    expect(futureChats).toHaveAttribute("aria-busy", "true");
  });

  updateGate.resolve(undefined);
  await responsePrepared.promise;
  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(
      screen.queryByRole("group", { name: "Model for this chat" }),
    ).not.toBeInTheDocument();
  });
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
});

test("Keep the model picker stable while settings refresh", async () => {
  const user = userEvent.setup({ delay: null });
  const refreshGate = createDeferredPromise<void>(context.signal);
  let preferenceRequestCount = 0;
  installNewChat(["claude-fable-5", "claude-sonnet-4-6"], "claude-fable-5");
  context.mocks.api(userModelPreferenceContract.get, async ({ respond }) => {
    preferenceRequestCount += 1;
    if (preferenceRequestCount > 1) {
      await refreshGate.promise;
    }
    return respond(200, preference("claude-fable-5"));
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await user.click(await modelPicker("Claude Fable 5"));
  await expect(
    screen.findByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
  ).resolves.toBeVisible();

  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(preferenceRequestCount).toBeGreaterThan(1);
  });
  expect(
    screen.getByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
  ).toBeVisible();
  await expect(modelPicker("Claude Fable 5")).resolves.toHaveAttribute(
    "aria-expanded",
    "true",
  );

  refreshGate.resolve(undefined);
  await waitFor(() => {
    expect(
      screen.getByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Claude Fable 5" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

test("Follow model preference changes made in another session", async () => {
  installNewChat(["claude-fable-5", "claude-opus-4-8"], "claude-fable-5");

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await expect(modelPicker("Claude Fable 5")).resolves.toBeVisible();

  context.mocks.data.userModelPreference({
    ...preference("claude-opus-4-8"),
    selectedImageModel: "gpt-image-1",
  });
  triggerAblyEvent("userPreferenceChanged", {
    kinds: ["defaultModel", "defaultImageModel", "futurePreferenceKind"],
  });

  await expect(modelPicker("Claude Opus 4.8")).resolves.toBeVisible();
});

test("Explain model availability by plan and provider", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "deepseek-v4-flash" });
  context.mocks.data.userModelPreference(preference("deepseek-v4-flash"));
  context.mocks.data.orgModelPolicies([
    modelPolicy("deepseek-v4-flash", 1, { default: true }),
    modelPolicy("gpt-5.6-luna", 2),
    modelPolicy("gpt-5.6-sol", 3),
    modelPolicy("claude-fable-5-1", 4),
    modelPolicy("gpt-6-astra", 5),
    modelPolicy("claude-sonnet-4-6", 6, {
      providerType: "anthropic-api-key",
      credentialScope: "member",
    }),
  ]);
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, limitedFreeBillingStatus());
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await user.click(await modelPicker("DeepSeek V4 Flash"));
  await expect(
    screen.findByRole("option", { name: /^DeepSeek V4 Flash/iu }),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("option", { name: /^GPT 5\.6 Luna/iu }),
  ).toBeVisible();
  expect(
    screen.getByRole("option", { name: /^GPT 6 Astra.*Pro/iu }),
  ).toBeVisible();
  expect(screen.getAllByText("Pro")).toHaveLength(4);
  expect(screen.getByText("BYOK")).toBeVisible();

  await user.click(
    screen.getByRole("option", { name: /^Claude Fable 5\.1/iu }),
  );
  const planDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(planDialog).toBeVisible();
  // The composer opened the upgrade flow, so dismissing it returns to the
  // composer instead of leaving the Settings billing tab open underneath.
  click(buttonNamed("Close", planDialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Settings" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "DeepSeek V4 Flash" }),
  ).toBeVisible();
});

test("Let an existing thread send while model availability is reconciling", async () => {
  const policyGate = createDeferredPromise<void>(context.signal);
  const sentPrompts: string[] = [];
  installRunChat({
    selectedModel: "claude-opus-5",
    onRunCreate: (body) => {
      if (body.prompt !== undefined) {
        sentPrompts.push(body.prompt);
      }
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Continue the saved analysis" }],
      },
      draftAttachments: null,
    });
  });
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    await policyGate.promise;
    return respond(200, {
      policies: [],
      workspaceDefaultModel: null,
      workspaceDefaultPolicyId: null,
    });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Continue the saved analysis");
  });
  expect(
    screen.queryByText(
      "The selected model is not available. Configure it before sending.",
    ),
  ).not.toBeInTheDocument();

  click(await findButton("Send"));
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual(["Continue the saved analysis"]);
  });

  policyGate.resolve(undefined);
  await expect(
    screen.findByText("Continue the saved analysis"),
  ).resolves.toBeVisible();
  expect(sentPrompts).toHaveLength(1);
});
