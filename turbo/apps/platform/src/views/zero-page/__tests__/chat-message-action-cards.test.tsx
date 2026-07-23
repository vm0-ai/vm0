import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { triggerAblyEvent, hasSubscription } from "../../../mocks/ably.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-action-cards";

function catalogPermissionDetail(
  overrides: Partial<PublicConnectorCatalogPermissionDetail> &
    Pick<
      PublicConnectorCatalogPermissionDetail,
      "connectorRef" | "label" | "permissions"
    >,
): PublicConnectorCatalogPermissionDetail {
  const { connectorRef, label, permissions, icon, ...rest } = overrides;
  return {
    connectorRef,
    label,
    icon: icon ?? {
      url: `https://icons.example.test/${connectorRef}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: permissions.length,
    permissions,
    categories: null,
    defaultPolicy: {
      permissionDefault: "ask",
      unknownPolicy: "ask",
    },
    ...rest,
  };
}

function applyUserConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledTypes: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledTypes]));
  }
  if (body.operation === "remove") {
    return current.filter((type) => {
      return !body.enabledTypes.includes(type);
    });
  }
  return [...body.enabledTypes];
}

function connectedConnector(
  overrides: Pick<ConnectorResponse, "type" | "authMethod"> &
    Partial<ConnectorResponse>,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function publicConnectorStatusItem(
  overrides: Partial<PublicConnectorCatalogStatusItem> &
    Pick<PublicConnectorCatalogStatusItem, "connectorRef" | "label">,
): PublicConnectorCatalogStatusItem {
  const { connectorRef, label, icon, ...rest } = overrides;
  return {
    connectorRef,
    label,
    description: `${label} public help text`,
    icon: icon ?? {
      url: `https://icons.example.test/${connectorRef}.svg`,
      invertInDarkMode: false,
    },
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
    ...rest,
  };
}

function mockConnectorCatalogStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function mockAgentConnectorAuthorizations(
  initialTypes: readonly string[],
): void {
  let enabledTypes: string[] = [...initialTypes];
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledTypes = applyUserConnectorUpdate(enabledTypes, body);
    return respond(200, { enabledTypes });
  });
}

function encodeBase64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function queryButtonByText(
  text: string,
  container: ParentNode,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

function buttonByText(text: string, container: ParentNode): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function waitForButtonByText(
  text: string,
  container: ParentNode,
): Promise<HTMLElement> {
  let button: HTMLElement | undefined;
  await waitFor(() => {
    button = buttonByText(text, container);
    expect(button).toBeEnabled();
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function confirmPermissionAction(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
): Promise<void> {
  await user.click(await waitForButtonByText("Confirm", card));
}

describe("chat message action cards", () => {
  it("opens a shared mail draft without reloading and refreshes after sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-000000000010";
    const messageId = "c0000000-0000-4000-a000-000000000011";
    const secondMessageId = "c0000000-0000-4000-a000-000000000013";
    const untrustedMessageId = "c0000000-0000-4000-a000-000000000017";
    const mailDraftId = "c0000000-0000-4000-a000-000000000012";
    const runId = "d0000000-0000-4000-a000-000000000020";
    const createdAt = "2026-07-14T10:00:00.000Z";
    let draftRequests = 0;
    let sent = false;
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;

    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        connectorRef: "gmail",
        label: "Gmail",
        icon: {
          url: "https://icons.example.test/gmail-catalog.svg",
          invertInDarkMode: true,
          scale: 1.25,
        },
      }),
    ]);

    context.mocks.api(zeroMailContract.getDraft, ({ respond }) => {
      draftRequests += 1;
      return respond(200, {
        mailDraftId,
        mailDraftUrl,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          cc: ["copy@example.com"],
          bcc: ["hidden@example.com"],
          subject: "Hello",
          body: "Mail body",
          replyTo: "reply-only@example.com",
          inReplyTo: "<thread-message@example.com>",
          status: sent ? "sent" : "draft",
          detailAvailable: true,
          gmailDraftId: "r-test-draft",
          gmailThreadId: "gmail-thread-id",
          gmailMessageId: "gmail-message-id",
          ...(sent
            ? {
                sentGmailMessageId: "gmail-sent-message-id",
                sentAt: "2026-07-14T10:01:00.000Z",
              }
            : {}),
          references: ["<reference-message@example.com>"],
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 248_192,
            },
          ],
          createdAt,
          updatedAt: sent ? "2026-07-14T10:01:00.000Z" : createdAt,
        },
      });
    });
    context.mocks.api(zeroMailContract.sendDraft, ({ respond }) => {
      sent = true;
      return respond(200, {
        mailDraftId,
        mailDraftUrl,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          cc: ["copy@example.com"],
          bcc: ["hidden@example.com"],
          subject: "Hello",
          body: "Mail body",
          replyTo: "reply-only@example.com",
          inReplyTo: "<thread-message@example.com>",
          status: "sent",
          detailAvailable: true,
          gmailDraftId: "r-test-draft",
          gmailThreadId: "gmail-thread-id",
          gmailMessageId: "gmail-message-id",
          sentGmailMessageId: "gmail-sent-message-id",
          references: ["<reference-message@example.com>"],
          attachments: [
            {
              filename: "report.pdf",
              contentType: "application/pdf",
              size: 248_192,
            },
          ],
          createdAt,
          updatedAt: "2026-07-14T10:01:00.000Z",
          sentAt: "2026-07-14T10:01:00.000Z",
        },
      });
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Mail card",
      chatMessages: [
        {
          id: messageId,
          role: "assistant",
          content: mailDraftUrl,
          runId,
          createdAt,
        },
        {
          id: secondMessageId,
          role: "assistant",
          content: `[Review email](/mail/drafts/${mailDraftId})`,
          runId,
          createdAt: "2026-07-14T10:00:01.000Z",
        },
        {
          id: untrustedMessageId,
          role: "assistant",
          content: `[Untrusted email](https://evil.test/mail/drafts/${mailDraftId})`,
          runId,
          createdAt: "2026-07-14T10:00:02.000Z",
        },
      ],
      activeRunIds: [runId],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroMail]: true },
    });

    let cards: HTMLElement[] = [];
    await waitFor(() => {
      cards = queryAllByRoleFast("button").filter((button) => {
        return button.getAttribute("aria-label") === "Open draft email: Hello";
      });
      expect(cards).toHaveLength(2);
    });
    for (const card of cards) {
      expect(
        within(card).getByText("To: recipient@example.com"),
      ).toBeInTheDocument();
      expect(within(card).queryByText("sender@example.com")).toBeNull();
      const icon = card.querySelector<HTMLImageElement>(
        'img[src="https://icons.example.test/gmail-catalog.svg"]',
      );
      expect(icon).toHaveClass("zero-icon-mono");
      expect(icon).toHaveStyle({ transform: "scale(1.25)" });
    }
    const untrustedLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Untrusted email";
    });
    expect(untrustedLink).toHaveAttribute(
      "href",
      `https://evil.test/mail/drafts/${mailDraftId}`,
    );
    await user.click(cards[0]!);

    let sidebar = await screen.findByTestId("mail-draft-sidebar");
    expect(within(sidebar).getByText("sender@example.com")).toBeInTheDocument();
    expect(within(sidebar).getByText("copy@example.com")).toBeInTheDocument();
    expect(within(sidebar).getByText("hidden@example.com")).toBeInTheDocument();
    expect(within(sidebar).getByText("Mail body")).toBeInTheDocument();
    expect(within(sidebar).getByText("report.pdf")).toBeInTheDocument();
    expect(within(sidebar).getByText("242 KB")).toBeInTheDocument();
    expect(within(sidebar).queryByText(/application\/pdf/u)).toBeNull();
    expect(within(sidebar).queryByText("reply-only@example.com")).toBeNull();
    expect(
      within(sidebar).queryByText("<thread-message@example.com>"),
    ).toBeNull();
    expect(
      within(sidebar).queryByText("<reference-message@example.com>"),
    ).toBeNull();
    expect(within(sidebar).queryByRole("textbox")).not.toBeInTheDocument();
    expect(draftRequests).toBe(1);
    await user.click(await waitForButtonByText("Send", sidebar));

    await waitFor(() => {
      expect(sent).toBeTruthy();
      expect(screen.getAllByText("Sent")).toHaveLength(2);
    });
    sidebar = await screen.findByTestId("mail-draft-sidebar");
    expect(queryButtonByText("Send", sidebar)).toBeNull();
    expect(draftRequests).toBe(2);
  });

  it("renders canonical connector actions on alternate production origins", async () => {
    const previousUrl = window.location.href;
    const threadId = `${THREAD_ID}-alternate-production-origin`;
    window.location.href = `https://app.okou.ai/chats/${threadId}`;
    context.signal.addEventListener(
      "abort",
      () => {
        window.location.href = previousUrl;
      },
      { once: true },
    );

    const canonicalUrl = `https://app.vm0.ai/connectors/slack/authorize?agentId=${AGENT_ID}`;
    const untrustedUrl = `https://evil.example.test/connectors/slack/authorize?agentId=${AGENT_ID}`;
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        connectorRef: "slack",
        label: "Slack",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Alternate production origin",
      chatMessages: [
        {
          id: "msg-user-alternate-production-origin",
          role: "user",
          content: "Authorize Slack",
          runId: "run-alternate-production-origin",
          createdAt: "2026-07-23T10:00:00Z",
        },
        {
          id: "msg-assistant-alternate-production-origin",
          role: "assistant",
          content: `${canonicalUrl}\n\n[Untrusted connector](${untrustedUrl})`,
          runId: "run-alternate-production-origin",
          createdAt: "2026-07-23T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const connectorCard = await screen.findByTestId("connector-action-card");
    expect(within(connectorCard).getByText("Slack")).toBeInTheDocument();
    const untrustedLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Untrusted connector";
    });
    expect(untrustedLink).toHaveAttribute("href", untrustedUrl);
  });

  it("connects a single OAuth connector directly and resumes the chat", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = `${THREAD_ID}-direct-oauth`;
    const callbackPrompt = "Re-check GitHub access, then continue";
    const connectorUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`;
    const sentPrompts: string[] = [];
    let connected = false;
    let authorized = false;
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    context.mocks.data.connectors([]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          publicConnectorStatusItem({
            connectorRef: "github",
            label: "GitHub",
            connected,
            connectionStatus: connected ? "connected" : "not-connected",
            connection: connected
              ? {
                  authMethod: "oauth",
                  externalUsername: "octocat",
                  externalEmail: null,
                  reconnectReason: null,
                }
              : null,
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
            singleAuthCodeAuthMethodId: "oauth",
          }),
        ],
      });
    });
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledTypes: authorized ? ["github"] : [],
      });
    });
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          authMethod: "oauth",
          agentId: AGENT_ID,
          authorizeAgent: true,
          callbackTarget: "app",
        });
        connected = true;
        authorized = true;
        context.mocks.data.connectors([
          connectedConnector({
            type: "github",
            authMethod: "oauth",
            externalUsername: "octocat",
            updatedAt: "2026-01-01T00:00:01Z",
          }),
        ]);
        return respond(200, {
          authorizationUrl: "https://oauth.test/github/authorize",
        });
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Direct OAuth connector",
      chatMessages: [
        {
          id: "msg-user-direct-oauth",
          role: "user",
          content: "Use GitHub",
          runId: "run-direct-oauth",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-direct-oauth",
          role: "assistant",
          content: connectorUrl,
          runId: "run-direct-oauth",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onSendRequest: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const connectorCard = await screen.findByTestId("connector-action-card");
    await user.click(await waitForButtonByText("Connect", connectorCard));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
    });
    expect(
      screen.queryByRole("dialog", { name: "GitHub" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(sentPrompts).toStrictEqual([callbackPrompt]);
      expect(within(connectorCard).getByText("Authorize")).toBeInTheDocument();
    });
  });

  it("enables a single no-auth connector directly", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = `${THREAD_ID}-direct-no-auth`;
    const connectorUrl = `${window.location.origin}/connectors/stripe/authorize?agentId=${AGENT_ID}`;
    let connected = false;
    let authorized = false;
    let connectCalls = 0;
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          publicConnectorStatusItem({
            connectorRef: "stripe",
            label: "Public Stripe",
            connected,
            connectionStatus: connected ? "connected" : "not-connected",
            authMethods: [
              {
                id: "api",
                label: "Public catalog",
                description: null,
                grantKind: "none",
                manualFields: [],
                startOptions: [],
              },
            ],
          }),
        ],
      });
    });
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledTypes: authorized ? ["stripe"] : [],
      });
    });
    context.mocks.api(
      zeroConnectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCalls += 1;
        expect(params.type).toBe("stripe");
        expect(body).toStrictEqual({
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        connected = true;
        authorized = true;
        return respond(
          200,
          connectedConnector({ type: "stripe", authMethod: "api" }),
        );
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Direct no-auth connector",
      chatMessages: [
        {
          id: "msg-user-direct-no-auth",
          role: "user",
          content: "Use public Stripe data",
          runId: "run-direct-no-auth",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-direct-no-auth",
          role: "assistant",
          content: connectorUrl,
          runId: "run-direct-no-auth",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const connectorCard = await screen.findByTestId("connector-action-card");
    await user.click(await waitForButtonByText("Connect", connectorCard));

    await waitFor(() => {
      expect(connectCalls).toBe(1);
      expect(within(connectorCard).getByText("Authorize")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("dialog", { name: "Public Stripe" }),
    ).not.toBeInTheDocument();
  });

  it("reloads the shared mail draft after deleting it", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-000000000018";
    const mailDraftId = "c0000000-0000-4000-a000-000000000019";
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
    const createdAt = "2026-07-14T10:00:00.000Z";
    let deleted = false;
    let draftRequests = 0;

    mockConnectorCatalogStatus([]);

    context.mocks.api(zeroMailContract.getDraft, ({ respond }) => {
      draftRequests += 1;
      if (deleted) {
        return respond(404, {
          error: { message: "Mail draft not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, {
        mailDraftId,
        mailDraftUrl,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          cc: [],
          bcc: [],
          subject: "Delete me",
          body: "Mail body",
          status: "draft",
          detailAvailable: true,
          gmailDraftId: "r-delete-draft",
          gmailThreadId: "gmail-thread-id",
          gmailMessageId: "gmail-message-id",
          references: [],
          attachments: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
    });
    context.mocks.api(zeroMailContract.deleteDraft, ({ respond }) => {
      deleted = true;
      return respond(204);
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Delete mail card",
      chatMessages: [
        {
          id: "c0000000-0000-4000-a000-00000000001a",
          role: "assistant",
          content: mailDraftUrl,
          createdAt,
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroMail]: true },
    });

    const card = await screen.findByLabelText("Open draft email: Delete me");
    expect(
      within(card).getByLabelText("Connector icon unavailable"),
    ).toBeInTheDocument();
    expect(draftRequests).toBe(1);
    await user.click(card);
    const sidebar = await screen.findByTestId("mail-draft-sidebar");
    expect(draftRequests).toBe(1);
    expect(within(sidebar).queryByText("Cc")).toBeNull();
    expect(within(sidebar).queryByText("Bcc")).toBeNull();
    await user.click(await waitForButtonByText("Delete", sidebar));

    await waitFor(() => {
      expect(deleted).toBeTruthy();
      expect(draftRequests).toBe(2);
      expect(screen.queryByLabelText("Open draft email: Delete me")).toBeNull();
      expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
    });
  });

  it("renders a deleted email card without an interactive sidebar trigger", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-000000000014";
    const mailDraftId = "c0000000-0000-4000-a000-000000000015";
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
    const createdAt = "2026-07-14T10:00:00.000Z";

    context.mocks.api(zeroMailContract.getDraft, ({ respond }) => {
      return respond(200, {
        mailDraftId,
        mailDraftUrl,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: [],
          cc: [],
          bcc: [],
          subject: "Deleted provider draft",
          body: "",
          status: "deleted",
          detailAvailable: false,
          gmailDraftId: "r-deleted",
          gmailThreadId: "gmail-thread-id",
          gmailMessageId: "gmail-message-id",
          references: [],
          attachments: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Deleted email card",
      chatMessages: [
        {
          id: "c0000000-0000-4000-a000-000000000016",
          role: "assistant",
          content: mailDraftUrl,
          createdAt,
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroMail]: true },
    });

    const deletedCard = await screen.findByLabelText(
      "Deleted email: Deleted provider draft",
    );
    expect(deletedCard).toHaveAttribute("aria-disabled", "true");
    expect(deletedCard).not.toHaveAttribute("role", "button");
    await user.click(deletedCard);
    expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
  });

  it("shares connector state across assistant messages and confirms permissions", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const connectorAuthorizeUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=catalog.analytics%3Aread&action=allow&expiresIn=24h`;
    let capturedPermissionGrantBody: unknown = null;

    context.mocks.data.connectors([
      connectedConnector({
        type: "github",
        authMethod: "oauth",
        externalUsername: "octocat",
      }),
    ]);
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        connectorRef: "github",
        label: "Catalog GitHub",
        description: "Catalog GitHub server help text",
        icon: {
          url: "https://icons.example.test/action-github.svg",
          invertInDarkMode: true,
        },
        connected: true,
        connectionStatus: "connected",
        connection: {
          authMethod: "oauth",
          externalUsername: "octocat",
          externalEmail: null,
          reconnectReason: null,
        },
      }),
    ]);
    mockAgentConnectorAuthorizations([]);
    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ params, respond }) => {
        expect(params.connectorRef).toBe("slack");
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorRef: "slack",
            label: "Catalog Slack",
            permissions: [
              {
                name: "catalog.analytics:read",
                description: "Catalog analytics access",
              },
            ],
          }),
        });
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        capturedPermissionGrantBody = body;
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(24 * 60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: "Action cards",
      chatMessages: [
        {
          id: "msg-user-action-request",
          role: "user",
          content: "Set up the integrations",
          runId: "run-action-cards-one",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-connector-card",
          role: "assistant",
          content: connectorAuthorizeUrl,
          runId: "run-action-cards-one",
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-user-permission-request",
          role: "user",
          content: "Continue with permissions",
          runId: "run-action-cards-two",
          createdAt: "2026-06-09T10:00:45Z",
        },
        {
          id: "msg-assistant-action-cards",
          role: "assistant",
          content: `${connectorAuthorizeUrl}\n\n${permissionAuthorizeUrl}`,
          runId: "run-action-cards-two",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const connectorCards = await screen.findAllByTestId(
      "connector-action-card",
    );
    expect(connectorCards).toHaveLength(2);
    const connectorCard = connectorCards[0]!;
    expect(
      within(connectorCard).getByText("Catalog GitHub"),
    ).toBeInTheDocument();
    expect(
      within(connectorCard).getByText("Catalog GitHub server help text"),
    ).toBeInTheDocument();
    expect(connectorCard.querySelector("img")).toHaveAttribute(
      "src",
      "https://icons.example.test/action-github.svg",
    );
    await user.click(within(connectorCard).getByText("Connect"));

    await waitFor(() => {
      for (const card of connectorCards) {
        expect(within(card).getByText("Authorize")).toBeInTheDocument();
      }
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Catalog Slack permissions"),
      ).toBeInTheDocument();
      expect(
        within(permissionCard).getByText("Allow catalog.analytics:read"),
      ).toBeInTheDocument();
    });
    expect(within(permissionCard).getByText("24 hours")).toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedPermissionGrantBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "slack",
        mode: "patch",
        grants: [
          {
            permission: "catalog.analytics:read",
            action: "allow",
            expiresIn: "24h",
          },
        ],
      });
    });
  });

  it("renders and confirms multiple permission cards from one assistant message", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const createPermissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=google-sheets&permission=spreadsheets.create&action=allow&expiresIn=1h`;
    const writePermissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=google-sheets&permission=values.write&action=allow&expiresIn=1h`;
    const capturedPermissionGrantBodies: unknown[] = [];

    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ params, respond }) => {
        expect(params.connectorRef).toBe("google-sheets");
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorRef: "google-sheets",
            label: "Google Sheets",
            permissions: [
              {
                name: "spreadsheets.create",
                description: "Create spreadsheets",
              },
              {
                name: "values.write",
                description: "Write spreadsheet values",
              },
            ],
          }),
        });
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        capturedPermissionGrantBodies.push(body);
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(30 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-multiple-permissions`,
      threadTitle: "Multiple permission cards",
      chatMessages: [
        {
          id: "msg-user-multiple-permissions",
          role: "user",
          content: "Create and populate a spreadsheet",
          runId: "run-multiple-permissions",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-multiple-permissions",
          role: "assistant",
          content: `${createPermissionUrl}\n${writePermissionUrl}`,
          runId: "run-multiple-permissions",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-multiple-permissions`,
    });

    const permissionCards = await screen.findAllByTestId(
      "permission-action-card",
    );
    expect(permissionCards).toHaveLength(2);
    const [createCard, writeCard] = permissionCards;
    if (!createCard || !writeCard) {
      throw new Error("Expected two permission cards");
    }
    await waitFor(() => {
      expect(
        within(createCard).getByText("Allow spreadsheets.create"),
      ).toBeInTheDocument();
      expect(
        within(writeCard).getByText("Allow values.write"),
      ).toBeInTheDocument();
    });

    await confirmPermissionAction(user, createCard);
    await waitFor(() => {
      expect(
        within(createCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
    expect(
      within(createCard).queryByText("Expires in less than 1 hour"),
    ).not.toBeInTheDocument();
    await confirmPermissionAction(user, writeCard);
    await waitFor(() => {
      expect(
        within(writeCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
    expect(
      within(writeCard).queryByText("Expires in less than 1 hour"),
    ).not.toBeInTheDocument();

    expect(capturedPermissionGrantBodies).toStrictEqual([
      {
        agentId: AGENT_ID,
        connectorRef: "google-sheets",
        mode: "patch",
        grants: [
          {
            permission: "spreadsheets.create",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      },
      {
        agentId: AGENT_ID,
        connectorRef: "google-sheets",
        mode: "patch",
        grants: [
          {
            permission: "values.write",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      },
    ]);
  });

  it("runs a permission callback prompt after the grant is confirmed", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const threadId = `${THREAD_ID}-single-permission`;
    const callbackPrompt = "Re-check Slack access, then continue";
    const permissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=channels.read&action=allow&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`;
    const sentPrompts: {
      prompt: string;
      threadId?: string;
      structuredPrompt?: unknown;
    }[] = [];

    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ respond }) => {
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorRef: "slack",
            label: "Slack",
            permissions: [
              {
                name: "channels.read",
                description: "Read channels",
              },
            ],
          }),
        });
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Permission callback",
      chatMessages: [
        {
          id: "msg-user-single-permission",
          role: "user",
          content: "Read Slack channels",
          runId: "run-single-permission",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-single-permission",
          role: "assistant",
          content: permissionUrl,
          runId: "run-single-permission",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onSendRequest: ({ prompt, threadId: sentThreadId, structuredPrompt }) => {
        sentPrompts.push({
          prompt,
          threadId: sentThreadId,
          structuredPrompt,
        });
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual([
        {
          prompt: callbackPrompt,
          threadId,
          structuredPrompt: {
            version: 1,
            parts: [{ type: "text", text: callbackPrompt }],
          },
        },
      ]);
    });
  });

  it("runs a connector callback prompt after authorization", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = `${THREAD_ID}-single-connector`;
    const callbackPrompt = "Re-check GitHub access, then continue";
    const connectorUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`;
    const sentPrompts: string[] = [];

    context.mocks.data.connectors([
      connectedConnector({
        type: "github",
        authMethod: "oauth",
        externalUsername: "octocat",
      }),
    ]);
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        connectorRef: "github",
        label: "GitHub",
        connected: true,
        connectionStatus: "connected",
        connection: {
          authMethod: "oauth",
          externalUsername: "octocat",
          externalEmail: null,
          reconnectReason: null,
        },
      }),
    ]);
    mockAgentConnectorAuthorizations([]);
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Connector callback",
      chatMessages: [
        {
          id: "msg-user-single-connector",
          role: "user",
          content: "Use GitHub",
          runId: "run-single-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-single-connector",
          role: "assistant",
          content: connectorUrl,
          runId: "run-single-connector",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onSendRequest: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const connectorCard = await screen.findByTestId("connector-action-card");
    await user.click(await waitForButtonByText("Connect", connectorCard));

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual([callbackPrompt]);
      expect(within(connectorCard).getByText("Authorize")).toBeInTheDocument();
    });
  });

  it("omits connector action cards when catalog metadata is hidden", async () => {
    const hiddenConnectorAuthorizeUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
    const visibleConnectorAuthorizeUrl = `${window.location.origin}/connectors/slack/authorize?agentId=${AGENT_ID}`;
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        connectorRef: "slack",
        label: "Catalog Slack",
        description: "Catalog Slack server help text",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-hidden-connector-metadata`,
      threadTitle: "Hidden connector metadata",
      chatMessages: [
        {
          id: "msg-user-hidden-connector",
          role: "user",
          content: "Connect hidden catalog connector",
          runId: "run-hidden-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-hidden-connector-card",
          role: "assistant",
          content: `${hiddenConnectorAuthorizeUrl}\n\n${visibleConnectorAuthorizeUrl}`,
          runId: "run-hidden-connector",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-hidden-connector-metadata`,
    });

    const userMessage = await screen.findByText(
      "Connect hidden catalog connector",
    );
    expect(userMessage).toBeInTheDocument();
    const connectorCards = await screen.findAllByTestId(
      "connector-action-card",
    );
    expect(connectorCards).toHaveLength(1);
    expect(
      within(connectorCards[0]!).getByText("Catalog Slack"),
    ).toBeInTheDocument();
    expect(
      within(connectorCards[0]!).getByText("Catalog Slack server help text"),
    ).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("completes catalog-visible connectors without a bundled type", async () => {
    const user = userEvent.setup({ delay: null });
    const connectorAuthorizeUrl = `${window.location.origin}/connectors/future-connector/authorize?agentId=${AGENT_ID}`;
    let connected = false;
    let authorized = false;
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          publicConnectorStatusItem({
            connectorRef: "future-connector",
            label: "Catalog Future Connector",
            description: "Catalog future connector help text",
            connected,
            connectionStatus: connected ? "connected" : "not-connected",
            authMethods: [
              {
                id: "partner-token",
                label: "Partner token",
                description: null,
                grantKind: "manual",
                manualFields: [
                  {
                    id: "apiKey",
                    label: "API key",
                    required: true,
                    placeholder: "future-api-key",
                    inputType: "password",
                  },
                ],
                startOptions: [],
              },
            ],
          }),
        ],
      });
    });
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledTypes: authorized ? ["future-connector"] : [],
      });
    });
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.type).toBe("future-connector");
        expect(body.agentId).toBe(AGENT_ID);
        expect(body.authorizeAgent).toBeTruthy();
        connected = true;
        authorized = true;
        return respond(
          200,
          connectedConnector({
            type: "future-connector",
            authMethod: body.authMethod,
          }),
        );
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-future-connector`,
      threadTitle: "Future connector",
      chatMessages: [
        {
          id: "msg-user-future-connector",
          role: "user",
          content: "Connect future connector",
          runId: "run-future-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-future-connector-card",
          role: "assistant",
          content: connectorAuthorizeUrl,
          runId: "run-future-connector",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-future-connector`,
    });

    const connectorCard = await screen.findByTestId("connector-action-card");
    expect(
      within(connectorCard).getByText("Catalog Future Connector"),
    ).toBeInTheDocument();
    expect(
      within(connectorCard).getByText("Catalog future connector help text"),
    ).toBeInTheDocument();
    const connectButton = buttonByText("Connect", connectorCard);
    expect(connectButton).toBeEnabled();
    await user.click(connectButton);
    const apiKeyInputs =
      await screen.findAllByPlaceholderText("future-api-key");
    const apiKeyInput = apiKeyInputs.at(-1);
    if (!apiKeyInput) {
      throw new Error("Future connector API key input not found");
    }
    await user.type(apiKeyInput, "future-token");
    const currentApiKeyInput = screen
      .getAllByPlaceholderText("future-api-key")
      .at(-1);
    const saveButton = currentApiKeyInput
      ?.closest("form")
      ?.querySelector<HTMLElement>('button[type="submit"]');
    if (!saveButton) {
      throw new Error("Future connector save button not found");
    }
    await user.click(saveButton);

    await waitFor(() => {
      expect(within(connectorCard).getByText("Authorize")).toBeInTheDocument();
    });
  });

  it("fails closed when permission action metadata is hidden", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=hidden-connector&permission=hidden.permission&action=allow&expiresIn=1h`;
    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ respond }) => {
        return respond(404, {
          error: { message: "Connector not found", code: "NOT_FOUND" },
        });
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-hidden-permission-metadata`,
      threadTitle: "Hidden permission metadata",
      chatMessages: [
        {
          id: "msg-user-hidden-permission",
          role: "user",
          content: "Allow a hidden connector permission",
          runId: "run-hidden-permission",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-hidden-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-hidden-permission",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-hidden-permission-metadata`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("hidden-connector permissions"),
      ).toBeInTheDocument();
      expect(
        within(permissionCard).getByText("Unknown permission"),
      ).toBeInTheDocument();
    });
    expect(queryButtonByText("Confirm", permissionCard)).toBeNull();
  });

  it("shows already allowed permission action cards as read-only after refresh", async () => {
    mockNow();
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorRef: "youtube",
          permission: "videos.write",
          action: "allow",
          expiresAt: isoFromNowMs(7 * 24 * 60 * 60 * 1000),
          createdAt: "2026-06-09T11:00:00Z",
          updatedAt: "2026-06-09T11:01:00Z",
        },
      ]);
    });
    context.mocks.api(zeroUserPermissionGrantsContract.apply, ({ respond }) => {
      applyRequests += 1;
      return respond(200, []);
    });
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-already-allowed-permission`,
      threadTitle: "Permission already allowed",
      chatMessages: [
        {
          id: "msg-user-already-allowed-permission",
          role: "user",
          content: "Upload the video",
          runId: "run-already-allowed-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-already-allowed-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-already-allowed-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-already-allowed-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Already allowed"),
      ).toBeInTheDocument();
    });
    expect(
      within(permissionCard).getByText("Expires in 7 days"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).queryByText("Confirm"),
    ).not.toBeInTheDocument();
    expect(
      within(permissionCard).queryByLabelText("Permission duration"),
    ).not.toBeInTheDocument();
    expect(applyRequests).toBe(0);
  });

  it("lets users re-confirm expired allow permission action cards", async () => {
    mockNow();
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorRef: "youtube",
          permission: "videos.write",
          action: "allow",
          expiresAt: isoFromNowMs(-60 * 1000),
          createdAt: "2026-06-09T11:00:00Z",
          updatedAt: "2026-06-09T11:01:00Z",
        },
      ]);
    });
    context.mocks.api(zeroUserPermissionGrantsContract.apply, ({ respond }) => {
      applyRequests += 1;
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorRef: "youtube",
          permission: "videos.write",
          action: "allow",
          expiresAt: isoFromNowMs(24 * 60 * 60 * 1000),
          createdAt: "2026-06-09T11:00:00Z",
          updatedAt: "2026-06-09T12:00:00Z",
        },
      ]);
    });
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-expired-allowed-permission`,
      threadTitle: "Expired permission allow",
      chatMessages: [
        {
          id: "msg-user-expired-allowed-permission",
          role: "user",
          content: "Upload the video",
          runId: "run-expired-allowed-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-expired-allowed-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-expired-allowed-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-expired-allowed-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(within(permissionCard).getByText("Expired")).toBeInTheDocument();
      expect(within(permissionCard).getByText("Confirm")).toBeInTheDocument();
    });
    expect(
      within(permissionCard).queryByText("Already allowed"),
    ).not.toBeInTheDocument();

    await confirmPermissionAction(
      userEvent.setup({ delay: null }),
      permissionCard,
    );
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
    expect(applyRequests).toBe(1);
  });

  it("shows already denied permission action cards as read-only after refresh", async () => {
    const permissionDenyUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorRef: "slack",
          permission: "admin.analytics:read",
          action: "deny",
          expiresAt: null,
          createdAt: "2026-06-09T11:00:00Z",
          updatedAt: "2026-06-09T11:01:00Z",
        },
      ]);
    });
    context.mocks.api(zeroUserPermissionGrantsContract.apply, ({ respond }) => {
      applyRequests += 1;
      return respond(200, []);
    });
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-already-denied-permission`,
      threadTitle: "Permission already denied",
      chatMessages: [
        {
          id: "msg-user-already-denied-permission",
          role: "user",
          content: "Block the Slack analytics request",
          runId: "run-already-denied-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-already-denied-permission-card",
          role: "assistant",
          content: permissionDenyUrl,
          runId: "run-already-denied-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-already-denied-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Already denied"),
      ).toBeInTheDocument();
    });
    expect(
      within(permissionCard).queryByText("Confirm"),
    ).not.toBeInTheDocument();
    expect(
      within(permissionCard).queryByLabelText("Permission duration"),
    ).not.toBeInTheDocument();
    expect(applyRequests).toBe(0);
  });

  it("reloads permission cards when a connectorPermissionUpdated event arrives", async () => {
    mockNow();
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let grantAllowed = false;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(
        200,
        grantAllowed
          ? [
              {
                agentId: AGENT_ID,
                connectorRef: "youtube",
                permission: "videos.write",
                action: "allow" as const,
                expiresAt: isoFromNowMs(24 * 60 * 60 * 1000),
                createdAt: "2026-06-09T11:00:00Z",
                updatedAt: "2026-06-09T11:01:00Z",
              },
            ]
          : [],
      );
    });
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-updated-event`,
      threadTitle: "Permission updated event",
      chatMessages: [
        {
          id: "msg-user-permission-updated-event",
          role: "user",
          content: "Upload the video",
          runId: "run-permission-updated-event",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-updated-event-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-updated-event",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-updated-event`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitForButtonByText("Confirm", permissionCard);
    expect(
      within(permissionCard).queryByText("Already allowed"),
    ).not.toBeInTheDocument();

    // The authenticated bootstrap owns one user-level subscription shared by
    // every permission-grant reader, including all open chat threads.
    await waitFor(() => {
      expect(hasSubscription("connectorPermissionUpdated")).toBeTruthy();
    });
    grantAllowed = true;
    triggerAblyEvent("connectorPermissionUpdated");

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Already allowed"),
      ).toBeInTheDocument();
    });
    expect(queryButtonByText("Confirm", permissionCard)).toBeNull();
  });

  it("renders custom connector proposal links as configure cards", async () => {
    const proposalUrl = `${window.location.origin}/connectors/custom/proposal?p=${encodeBase64UrlJson(
      {
        operation: "create",
        displayName: "Acme Internal API",
        prefixTemplates: ["https://{{variables.subdomain}}.acme.test/v1/"],
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      },
    )}&agentId=${AGENT_ID}`;

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-custom-connector`,
      threadTitle: "Custom connector card",
      chatMessages: [
        {
          id: "msg-user-custom-connector",
          role: "user",
          content: "Set up the custom connector",
          runId: "run-custom-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-custom-connector-card",
          role: "assistant",
          content: proposalUrl,
          runId: "run-custom-connector",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-custom-connector`,
    });

    const card = await screen.findByTestId("custom-connector-action-card");
    expect(within(card).getByText("Acme Internal API")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Review, connect, and authorize this custom connector for the agent.",
      ),
    ).toBeInTheDocument();
    const configureLink = queryAllByRoleFast("link", card).find((link) => {
      return /configure/i.test(link.textContent ?? "");
    });
    expect(configureLink).toHaveAttribute("href", proposalUrl);
  });

  it("renders delegated computer use authorization links as action cards", async () => {
    const authorizationUrl =
      "https://app.vm0.ai/computer-use/authorize/vm0_computer_use_authorization_request_test";

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-computer-use-authorization`,
      threadTitle: "Computer Use authorization card",
      chatMessages: [
        {
          id: "msg-user-computer-use-authorization",
          role: "user",
          content: "Use my desktop",
          runId: "run-computer-use-authorization",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-computer-use-authorization-card",
          role: "assistant",
          content: authorizationUrl,
          runId: "run-computer-use-authorization",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-computer-use-authorization`,
    });

    const card = await screen.findByTestId("computer-use-authorization-card");
    expect(
      within(card).getByText("Computer Use authorization"),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Select a Desktop host for future runs in this thread.",
      ),
    ).toBeInTheDocument();
    const authorizeLink = queryAllByRoleFast("link", card).find((link) => {
      return /authorize/i.test(link.textContent ?? "");
    });
    expect(authorizeLink).toHaveAttribute(
      "href",
      "/computer-use/authorize/vm0_computer_use_authorization_request_test",
    );
  });

  it("automatically retries permission action loading before showing an error", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let listRequests = 0;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      listRequests += 1;
      if (listRequests === 1) {
        throw new Error("temporary permission grant load failure");
      }
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-load-retry`,
      threadTitle: "Permission load retry",
      chatMessages: [
        {
          id: "msg-user-permission-load-retry",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-load-retry",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-load-retry-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-load-retry",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-load-retry`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Gmail permissions"),
      ).toBeInTheDocument();
      expect(
        within(permissionCard).getByText("Allow messages.write"),
      ).toBeInTheDocument();
    });

    await waitForButtonByText("Confirm", permissionCard);
    expect(listRequests).toBe(2);
    expect(
      within(permissionCard).queryByText("Failed to load permissions"),
    ).not.toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "gmail",
        mode: "patch",
        grants: [
          {
            permission: "messages.write",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      });
    });
  });

  it("shows permission status loading outside the action button", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let resolveList: () => void = () => {
      throw new Error("Permission grant list request did not start");
    };
    context.mocks.api(
      zeroUserPermissionGrantsContract.list,
      async ({ deferred, respond }) => {
        const listDeferred = deferred<void>();
        resolveList = () => {
          listDeferred.resolve();
        };
        await listDeferred.promise;
        return respond(200, []);
      },
    );

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-status-loading`,
      threadTitle: "Permission status loading",
      chatMessages: [
        {
          id: "msg-user-permission-status-loading",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-status-loading",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-status-loading-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-status-loading",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-status-loading`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Checking permission status..."),
    ).toBeInTheDocument();
    expect(
      queryButtonByText("Checking permission status...", permissionCard),
    ).toBeNull();
    expect(queryButtonByText("Confirm", permissionCard)).toBeNull();

    resolveList();
    await waitForButtonByText("Confirm", permissionCard);
  });

  it("does not retry non-transient permission action loading failures", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let listRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      listRequests += 1;
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Forbidden",
        },
      });
    });

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-load-forbidden`,
      threadTitle: "Permission load forbidden",
      chatMessages: [
        {
          id: "msg-user-permission-load-forbidden",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-load-forbidden",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-load-forbidden-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-load-forbidden",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-load-forbidden`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Couldn't load permission status"),
      ).toBeInTheDocument();
    });
    expect(
      queryButtonByText("Failed to load permissions", permissionCard),
    ).toBeNull();
    expect(
      queryButtonByText("Couldn't load permission status", permissionCard),
    ).toBeNull();
    expect(queryButtonByText("Confirm", permissionCard)).toBeNull();
    expect(listRequests).toBe(1);
  });

  it("shows permission save failures outside the action button", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(zeroUserPermissionGrantsContract.apply, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Forbidden",
        },
      });
    });

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-save-error`,
      threadTitle: "Permission save error",
      chatMessages: [
        {
          id: "msg-user-permission-save-error",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-save-error",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-save-error-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-save-error",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-save-error`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Couldn't update permissions"),
      ).toBeInTheDocument();
    });
    expect(
      queryButtonByText("Couldn't update permissions", permissionCard),
    ).toBeNull();
    await waitForButtonByText("Confirm", permissionCard);
    expect(
      within(permissionCard).queryByText("Permissions updated"),
    ).not.toBeInTheDocument();
    expect(
      within(permissionCard).queryByText("Already allowed"),
    ).not.toBeInTheDocument();
  });

  it("keeps permission success visible while permission grants reload", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let listRequests = 0;
    let storedGrants: UserPermissionGrantResponse[] = [];
    let resolveReload: () => void = () => {
      throw new Error("Permission grant reload request did not start");
    };
    context.mocks.api(
      zeroUserPermissionGrantsContract.list,
      async ({ deferred, respond }) => {
        listRequests += 1;
        if (listRequests === 1) {
          return respond(200, []);
        }
        if (listRequests === 2) {
          const reloadDeferred = deferred<void>();
          resolveReload = () => {
            reloadDeferred.resolve();
          };
          await reloadDeferred.promise;
        }
        return respond(200, storedGrants);
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        storedGrants = [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ];
        return respond(200, storedGrants);
      },
    );

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-save-reload`,
      threadTitle: "Permission save reload",
      chatMessages: [
        {
          id: "msg-user-permission-save-reload",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-save-reload",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-save-reload-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-save-reload",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-save-reload`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(listRequests).toBe(2);
    });
    expect(
      within(permissionCard).getByText("Permissions updated"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).queryByText("Checking permission status..."),
    ).not.toBeInTheDocument();

    resolveReload();
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
  });

  it("lets users change permission duration before confirming", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(7 * 24 * 60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-duration`,
      threadTitle: "Permission duration",
      chatMessages: [
        {
          id: "msg-user-permission-duration-request",
          role: "user",
          content: "Allow Slack analytics for a week",
          runId: "run-permission-duration",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-duration-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-duration",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-duration`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitForButtonByText("Confirm", permissionCard);
    await user.click(
      within(permissionCard).getByLabelText("Permission duration"),
    );
    await user.click(await screen.findByText("7 days"));

    await waitFor(() => {
      expect(within(permissionCard).getByText("7 days")).toBeInTheDocument();
    });

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "slack",
        mode: "patch",
        grants: [
          {
            permission: "admin.analytics:read",
            action: "allow",
            expiresIn: "7d",
          },
        ],
      });
    });
  });

  it("lets users confirm unknown endpoint permissions from assistant messages", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=cloudflare&permission=${UNKNOWN_PERMISSION_GRANT}&action=allow&expiresIn=1h`;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(60 * 60 * 1000),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-unknown-permission`,
      threadTitle: "Unknown permission",
      chatMessages: [
        {
          id: "msg-user-unknown-permission-request",
          role: "user",
          content: "Allow the Cloudflare request",
          runId: "run-unknown-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-unknown-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-unknown-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-unknown-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Cloudflare permissions"),
      ).toBeInTheDocument();
      expect(
        within(permissionCard).getByText(`Allow ${UNKNOWN_PERMISSION_GRANT}`),
      ).toBeInTheDocument();
    });

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "cloudflare",
        mode: "patch",
        grants: [
          {
            permission: UNKNOWN_PERMISSION_GRANT,
            action: "allow",
            expiresIn: "1h",
          },
        ],
      });
    });
  });

  it("lets users deny a permission request from an assistant message", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionDenyUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`;
    let grants: UserPermissionGrantResponse[] = [
      {
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "admin.analytics:read",
        action: "allow",
        expiresAt: null,
        createdAt: "2026-06-09T10:30:00Z",
        updatedAt: "2026-06-09T10:30:00Z",
      },
    ];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const appliedGrant = body.grants[0];
        if (!appliedGrant) {
          throw new Error("Expected a permission grant");
        }
        expect(body.mode).toBe("patch");
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: appliedGrant.permission,
          action: appliedGrant.action,
          expiresAt: null,
          createdAt: grants[0]?.createdAt ?? "2026-06-09T10:30:00Z",
          updatedAt: "2026-06-09T11:02:00Z",
        };
        grants = [grant];
        return respond(200, [grant]);
      },
    );

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-deny`,
      threadTitle: "Permission action",
      chatMessages: [
        {
          id: "msg-user-permission-block-request",
          role: "user",
          content: "Block Slack analytics access",
          runId: "run-permission-block",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-block-card",
          role: "assistant",
          content: permissionDenyUrl,
          runId: "run-permission-block",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-deny`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Slack permissions"),
      ).toBeInTheDocument();
      expect(
        within(permissionCard).getByText("Deny admin.analytics:read"),
      ).toBeInTheDocument();
    });

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permission denied"),
      ).toBeInTheDocument();
    });
  });
});
