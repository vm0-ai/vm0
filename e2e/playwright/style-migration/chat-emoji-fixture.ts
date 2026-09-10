import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { fixtureBootstrap } from "./bootstrap";
import { installChatEmojiWorkerFixture } from "./chat-emoji-worker";

export const threadId = "b3969267-d928-4277-9568-99e91d54ca12";
const agentId = "c3969267-d928-4277-9568-99e91d54ca12";
const timestamp = "2026-09-01T00:00:00.000Z";

// Only external API responses are substituted. The deployed Router, header,
// picker, production emoji catalog, event handlers and CSS remain real.
export async function installChatEmojiFixture(
  page: Page,
  appOrigin: string,
  apiOrigin: string,
  theme: "light" | "dark",
  failures: string[],
  chromiumProfile: string,
) {
  let title = "😀 Emoji planning ABC 中文";
  const agent = {
    agentId,
    ownerId: "chat-emoji-test-owner",
    displayName: "Okou",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
  const preferences = {
    timezone: "UTC",
    locale: "en-US",
    translationLanguage: "en",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: false,
    theme,
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
  const switches = {
    chatThreadHeaderActions: true,
    _realAgentInPreview: false,
  };
  const thread = () => ({
    id: threadId,
    agentId,
    title,
    sortAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    renamedAt: timestamp,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  });
  const fixtures = (): Record<string, unknown> => ({
    "/api/user-preferences": preferences,
    "/api/feature-switches": { switches, effectiveSwitches: switches },
    "/api/onboarding/status": {
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: agentId,
      defaultAgentMetadata: {
        displayName: agent.displayName,
        avatarUrl: null,
        sound: null,
      },
    },
    "/api/org": {
      id: "chat-emoji-test-org",
      name: "Emoji TEST",
      role: "admin",
    },
    "/api/org/logo": { logoUrl: null, hasImage: false },
    "/api/agents": [agent],
    [`/api/agents/${agentId}`]: agent,
    [`/api/agents/${agentId}/user-connectors`]: { enabledConnectorSlugs: [] },
    [`/api/agents/${agentId}/custom-connectors`]: { grants: [] },
    "/api/indicators": { agents: {}, threads: {} },
    "/api/chat-thread-drafts": { draftThreadIds: [] },
    "/api/chat-threads/snapshot": {
      chatThreads: [thread()],
      latestEventId: null,
      latestSeqId: null,
    },
    "/api/chat-threads/events": { events: [], hasMore: false },
    [`/api/chat-threads/${threadId}`]: {
      lastReadAt: timestamp,
      cancellationRecoveryPending: false,
    },
    [`/api/chat-threads/${threadId}/metadata`]: thread(),
    [`/api/chat-threads/${threadId}/draft`]: {
      draftUserMessage: null,
      draftAttachments: null,
    },
    [`/api/chat-threads/${threadId}/event-rows`]: {
      rows: [],
      cursor: { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    },
    [`/api/chat-threads/${threadId}/artifacts`]: { runs: [] },
    [`/api/chat-threads/${threadId}/workflow-automations`]: { automations: [] },
    "/api/billing/status": {
      tier: "pro",
      showUsagePack: false,
      credits: 2000,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    },
  });
  const worker = await installChatEmojiWorkerFixture(
    chromiumProfile,
    apiOrigin,
    fixtures,
    failures,
  );
  await fixtureBootstrap(page, appOrigin, fixtures);
  await page.context().route(
    (url) => url.origin === apiOrigin,
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      try {
        if (pathname === `/api/chat-threads/${threadId}/rename`) {
          assert.equal(method, "POST");
          const update: { title: string } = request.postDataJSON();
          assert(
            ["🈯 Emoji planning ABC 中文", "Emoji planning ABC 中文"].includes(
              update.title,
            ),
          );
          title = update.title;
          await route.fulfill({ status: 204 });
        } else if (
          pathname === `/api/chat-threads/${threadId}/event-snapshot`
        ) {
          await route.fulfill({
            status: 404,
            json: {
              error: {
                code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
                message: "Chat event snapshot not found",
              },
            },
          });
        } else if (pathname === `/api/chat-threads/${threadId}/mark-read`) {
          await route.fulfill({ json: { lastReadAt: timestamp, unreads: {} } });
        } else if (pathname === "/api/chat/events/catch-up") {
          await route.fulfill({
            json: { events: { [threadId]: [] }, notFoundThreads: [] },
          });
        } else if (pathname === "/api/user-preferences" && method === "POST") {
          const update: Record<string, unknown> = request.postDataJSON();
          for (const [key, value] of Object.entries(update))
            assert.deepEqual(value, Reflect.get(preferences, key));
          await route.fulfill({ json: preferences });
        } else if (fixtures()[pathname] !== undefined && method === "GET") {
          await route.fulfill({ json: fixtures()[pathname] });
        } else {
          // Realtime authentication is a read prerequisite, never an Agent run.
          assert(
            method === "GET" || pathname === "/api/realtime/token",
            `Unexpected write: ${method} ${pathname}`,
          );
          await route.fallback();
        }
      } catch (error) {
        failures.push(`chat-emoji fixture: ${String(error)}`);
        await route.fulfill({ status: 500, body: "Fixture rejected request" });
      }
    },
  );
  return worker;
}
