import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  completedConversation,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";
import {
  assistantEvent,
  findButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";

const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000001101";
const OTHER_THREAD_ID = "b0000000-0000-4000-a000-000000001102";
const ACTION_RUN_ID = "d0000000-0000-4000-a000-000000001103";
const INITIAL_SCREENSHOT_URL =
  "https://images.example.test/browser-initial.png";
const SUSPENDED_SCREENSHOT_URL =
  "https://images.example.test/browser-suspended.png";
const ACTIVE_BROWSER_URL = "https://browser.example.test/live/initial";
const RESUMED_BROWSER_URL = "https://browser.example.test/live/resumed";

function managedBrowserSession(args: {
  readonly status: "active" | "suspended";
  readonly screenshotUrl: string;
  readonly liveUrl: string | null;
}): BrowserSession {
  return {
    threadId: RUN_THREAD_ID,
    name: "Research",
    status: args.status,
    viewerUrl: `https://browser.example.test/view/${RUN_THREAD_ID}`,
    liveUrl: args.liveUrl,
    screenshotUrl: args.screenshotUrl,
    proxyCountryCode: "US",
    timeoutMinutes: 240,
    ...(args.status === "active"
      ? {
          screen: { width: 1440, height: 900, resizable: true },
          idleExpiresAt: "2026-08-18T12:10:00.000Z",
          suspendedAt: null,
          suspensionReason: null,
        }
      : {
          idleExpiresAt: null,
          suspendedAt: "2026-08-18T12:05:00.000Z",
          suspensionReason: "idle" as const,
        }),
    createdAt: "2026-08-18T11:00:00.000Z",
    updatedAt: "2026-08-18T12:05:00.000Z",
  };
}

function planActionUrl(origin: string): string {
  const url = new URL("/", origin);
  url.searchParams.set("settings", "billing");
  url.searchParams.set("billingView", "plans");
  return url.href;
}

function computerAuthorizationUrl(origin: string, token: string): string {
  return new URL(`/computer-use/authorize/${token}`, origin).href;
}

function connectorAuthorizationUrl(args: {
  readonly agentId?: string;
  readonly threadId?: string;
  readonly callbackPrompt?: string;
}): string {
  const url = new URL("/connectors/slack/authorize", "https://app.vm0.ai");
  if (args.agentId !== undefined) {
    url.searchParams.set("agentId", args.agentId);
  }
  if (args.threadId !== undefined) {
    url.searchParams.set("threadId", args.threadId);
  }
  if (args.callbackPrompt !== undefined) {
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

function linkByName(name: string, container: ParentNode = document.body) {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!link) {
    throw new Error(`${name} link was not visible`);
  }
  return link;
}

function buttonsByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
}

test("Follow a managed browser session from its chat card", async () => {
  let browser = managedBrowserSession({
    status: "active",
    screenshotUrl: INITIAL_SCREENSHOT_URL,
    liveUrl: ACTIVE_BROWSER_URL,
  });
  const trustedBrowserUrl = `https://app.vm0.ai/browsers/${RUN_THREAD_ID}`;
  const foreignBrowserUrl = `https://app.vm0.ai/browsers/${OTHER_THREAD_ID}`;
  const untrustedBrowserUrl = `https://app.vm0.ai.evil.test/browsers/${RUN_THREAD_ID}`;
  installCapabilityChat({
    events: completedConversation(
      [
        `[Research session](${trustedBrowserUrl})`,
        `[Other conversation browser](${foreignBrowserUrl})`,
        `[Untrusted browser](${untrustedBrowserUrl})`,
      ].join("\n\n"),
    ),
  });
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });
  context.mocks.api(browserContract.open, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser, lifecycleEventId: null });
  });
  context.mocks.api(browserContract.leaseByThread, ({ params, respond }) => {
    expect(params.threadId).toBe(RUN_THREAD_ID);
    return respond(200, { browser });
  });

  await setupPage({ context, path: RUN_PATH, host: "app.vm0.ai" });

  await readyChat();
  const card = await findButton("Open Research browser");
  expect(card).toHaveTextContent("Cloud browser");
  expect(card).toHaveTextContent("Live");
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    INITIAL_SCREENSHOT_URL,
  );

  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Live browser",
  });
  expect(sidebar).toBeVisible();
  expect(screen.getByTitle("Live browser: Research")).toHaveAttribute(
    "src",
    ACTIVE_BROWSER_URL,
  );
  expect(screen.getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    INITIAL_SCREENSHOT_URL,
  );

  browser = managedBrowserSession({
    status: "suspended",
    screenshotUrl: SUSPENDED_SCREENSHOT_URL,
    liveUrl: null,
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: RUN_THREAD_ID,
  });

  await waitFor(() => {
    expect(buttonsByName("Open Research browser")[0]).toHaveTextContent(
      "Stopped",
    );
  });
  expect(screen.queryByTitle("Live browser: Research")).toBeNull();
  await expect(
    screen.findByTestId("browser-session-panel-screenshot"),
  ).resolves.toHaveAttribute("src", SUSPENDED_SCREENSHOT_URL);
  expect(within(sidebar).getByText("Browser not live")).toBeVisible();

  browser = managedBrowserSession({
    status: "active",
    screenshotUrl: SUSPENDED_SCREENSHOT_URL,
    liveUrl: RESUMED_BROWSER_URL,
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: RUN_THREAD_ID,
  });

  await waitFor(() => {
    expect(screen.getByText("Live")).toBeVisible();
  });
  await expect(
    screen.findByTitle("Live browser: Research"),
  ).resolves.toHaveAttribute("src", RESUMED_BROWSER_URL);
  expect(screen.queryByTestId("browser-session-panel-screenshot")).toBeNull();

  const foreignLink = linkByName("Other conversation browser");
  expect(foreignLink).toHaveAttribute("href", foreignBrowserUrl);
  expect(foreignLink.closest("[data-browser-session-card]")).toBeNull();
  const untrustedLink = linkByName("Untrusted browser");
  expect(untrustedLink).toHaveAttribute("href", untrustedBrowserUrl);
  expect(untrustedLink.closest("[data-browser-session-card]")).toBeNull();
});

test("Recognize trusted assistant actions without trusting lookalikes", async () => {
  const trustedPlan = planActionUrl("https://app.okou.ai");
  const trustedComputer = computerAuthorizationUrl(
    "https://app.okou.ai",
    "assistant-trusted",
  );
  const userText = [
    `[User plan action](${trustedPlan})`,
    `[User computer action](${trustedComputer})`,
  ].join("\n\n");
  const assistantText = [
    `[Assistant plan action](${trustedPlan})`,
    `[Assistant computer action](${trustedComputer})`,
    `[Forged action](${computerAuthorizationUrl("https://app.vm0.ai.evil.test", "forged")})`,
    "Wrong agent:",
    connectorAuthorizationUrl({
      agentId: OTHER_AGENT_ID,
      threadId: RUN_THREAD_ID,
      callbackPrompt: "Continue after authorization",
    }),
    "Wrong conversation:",
    connectorAuthorizationUrl({
      agentId: CAPABILITY_AGENT_ID,
      threadId: OTHER_THREAD_ID,
      callbackPrompt: "Continue in another conversation",
    }),
    "Missing action context:",
    connectorAuthorizationUrl({}),
    "Unavailable agent:",
    `https://app.vm0.ai/agents/${OTHER_AGENT_ID}/permissions?connectorSlug=slack&permission=messages.read`,
  ].join("\n\n");
  installCapabilityChat({
    events: [
      promptEvent({
        id: "safe-actions-user",
        runId: ACTION_RUN_ID,
        seqId: 1,
        text: userText,
      }),
      assistantEvent({
        id: "safe-actions-assistant",
        runId: ACTION_RUN_ID,
        seqId: 2,
        text: assistantText,
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH, host: "app.vm0.ai" });

  await readyChat();
  await expect(
    screen.findByText("Upgrade your workspace"),
  ).resolves.toBeVisible();
  expect(screen.getAllByText("Upgrade your workspace")).toHaveLength(1);
  expect(screen.getAllByText("Computer Use authorization")).toHaveLength(1);
  const userMessage = screen
    .getByText(/User plan action/u)
    .closest<HTMLElement>('[data-role="user"]');
  if (!userMessage) {
    throw new Error("User action-like text was not visible");
  }
  expect(userMessage).toHaveTextContent("User plan action");
  expect(userMessage).toHaveTextContent("User computer action");
  expect(within(userMessage).queryByText("Upgrade your workspace")).toBeNull();
  expect(
    within(userMessage).queryByText("Computer Use authorization"),
  ).toBeNull();
  expect(linkByName("Forged action")).toBeVisible();

  await waitFor(() => {
    expect(screen.getAllByText("Action unavailable")).toHaveLength(4);
  });
  const unavailableCards = screen
    .getAllByText("Action unavailable")
    .map((title) => {
      const card = title.closest<HTMLElement>(
        '[data-testid="unavailable-action-card"]',
      );
      if (!card) {
        throw new Error("Unavailable action card was not mounted");
      }
      return card;
    });
  for (const card of unavailableCards) {
    expect(queryAllByRoleFast("button", card)).toHaveLength(0);
    expect(queryAllByRoleFast("link", card)).toHaveLength(0);
  }

  click(await findButton("Compare plans"));

  await expect(
    screen.findByRole("dialog", { name: "Choose a plan" }),
  ).resolves.toBeVisible();
  expect(window.location.hostname).toBe("app.vm0.ai");
});
