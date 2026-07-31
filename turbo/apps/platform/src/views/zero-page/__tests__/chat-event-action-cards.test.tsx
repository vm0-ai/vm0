import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { chatThreadEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
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
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

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
      "connectorSlug" | "label" | "permissions"
    >,
): PublicConnectorCatalogPermissionDetail {
  const { connectorSlug, label, permissions, icon, ...rest } = overrides;
  return {
    connectorSlug,
    label,
    icon: icon ?? {
      url: `https://icons.example.test/${connectorSlug}.svg`,
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
    readonly enabledConnectorSlugs: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledConnectorSlugs]));
  }
  if (body.operation === "remove") {
    return current.filter((connectorSlug) => {
      return !body.enabledConnectorSlugs.includes(connectorSlug);
    });
  }
  return [...body.enabledConnectorSlugs];
}

function connectedConnector(
  overrides: Pick<ConnectorResponse, "slug" | "authMethod"> &
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
    Pick<PublicConnectorCatalogStatusItem, "slug" | "label">,
): PublicConnectorCatalogStatusItem {
  const { slug: connectorSlug, label, icon, ...rest } = overrides;
  return {
    slug: connectorSlug,
    label,
    description: `${label} public help text`,
    icon: icon ?? {
      url: `https://icons.example.test/${connectorSlug}.svg`,
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
  initialConnectorSlugs: readonly string[],
): void {
  let enabledConnectorSlugs: string[] = [...initialConnectorSlugs];
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs,
    });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledConnectorSlugs = applyUserConnectorUpdate(
      enabledConnectorSlugs,
      body,
    );
    return respond(200, {
      enabledConnectorSlugs,
    });
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

function linkByText(text: string, container: ParentNode): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
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

async function waitForSelectionToolbarButton(
  text: string,
): Promise<HTMLElement> {
  let button: HTMLElement | undefined;
  await waitFor(() => {
    button = queryAllByRoleFast("button").find((candidate) => {
      const label = candidate.textContent?.replace(/\s+/g, " ").trim();
      return (
        label === text ||
        label === `${text} C` ||
        label === `${text} F` ||
        label === `${text}C` ||
        label === `${text}F`
      );
    });
    expect(button).toBeEnabled();
  });
  if (!button) {
    throw new Error(`${text} selection toolbar button not found`);
  }
  return button;
}

async function confirmPermissionAction(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
): Promise<void> {
  await user.click(await waitForButtonByText("Confirm", card));
}

const MAIL_FOLLOW_UP_SUBJECT = "July receipts";

async function waitForMailDraftCard(): Promise<HTMLElement> {
  let card: HTMLElement | undefined;
  await waitFor(() => {
    card = queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-label") ===
        `Open draft email: ${MAIL_FOLLOW_UP_SUBJECT}`
      );
    });
    expect(card).toBeDefined();
  });
  if (!card) {
    throw new Error("Mail draft card not found");
  }
  return card;
}

function mailFollowUpScenario(args: {
  readonly threadId: string;
  readonly mailDraftId: string;
}): {
  readonly threadId: string;
  readonly mailDraftId: string;
  readonly sentPrompts: { prompt: string; threadId?: string }[];
  readonly followUpRequests: string[];
} {
  const { threadId, mailDraftId } = args;
  const createdAt = "2026-07-14T10:00:00.000Z";
  const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
  const sentPrompts: { prompt: string; threadId?: string }[] = [];
  const followUpRequests: string[] = [];
  let sent = false;
  let followUp:
    | {
        readonly status: "active";
        readonly automationId: string;
      }
    | undefined;
  const mailDraft = (status: "draft" | "sent") => {
    return {
      version: 3 as const,
      provider: "gmail" as const,
      from: "sender@example.com",
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: MAIL_FOLLOW_UP_SUBJECT,
      body: "Mail body",
      status,
      detailAvailable: true,
      gmailDraftId: "r-callback-draft",
      gmailThreadId: "gmail-thread-id",
      gmailMessageId: "gmail-message-id",
      ...(status === "sent"
        ? {
            sentGmailMessageId: "gmail-sent-message-id",
            sentAt: "2026-07-14T10:01:00.000Z",
            ...(followUp ? { followUp } : {}),
          }
        : {}),
      references: [],
      attachments: [],
      createdAt,
      updatedAt: createdAt,
    };
  };

  mockConnectorCatalogStatus([
    publicConnectorStatusItem({ slug: "gmail", label: "Gmail" }),
  ]);
  context.mocks.api(zeroMailContract.getDraft, ({ respond }) => {
    return respond(200, {
      mailDraftId,
      mailDraftUrl,
      mailDraft: mailDraft(sent ? "sent" : "draft"),
    });
  });
  context.mocks.api(zeroMailContract.sendDraft, ({ respond }) => {
    sent = true;
    return respond(200, {
      mailDraftId,
      mailDraftUrl,
      mailDraft: mailDraft("sent"),
    });
  });
  context.mocks.api(zeroMailContract.createFollowUp, ({ params, respond }) => {
    followUpRequests.push(params.mailDraftId);
    followUp = {
      status: "active",
      automationId: "c0000000-0000-4000-a000-000000000044",
    };
    return respond(200, {
      mailDraftId,
      automationId: followUp.automationId,
    });
  });
  mockChatLifecycle(context, {
    threadId,
    threadTitle: "Mail follow-up",
    chatEvents: [
      {
        id: `${mailDraftId}-message`,
        role: "assistant",
        content: mailDraftUrl,
        runId: `${mailDraftId}-run`,
        createdAt,
      },
    ],
    onSendRequest: ({ prompt, threadId: sentThreadId }) => {
      sentPrompts.push({ prompt, threadId: sentThreadId });
    },
  });

  return {
    threadId,
    mailDraftId,
    sentPrompts,
    followUpRequests,
  };
}

function selectMailText(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(24, 32, 180, 20);
    },
  });
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is not available");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

describe("chat event action cards", () => {
  it("keeps connector action card height stable while catalog metadata loads", async () => {
    const threadId = `${THREAD_ID}-connector-loading-height`;
    const connectorUrl = `${window.location.origin}/connectors/slack/authorize?agentId=${AGENT_ID}`;
    let catalogRequestStarted = false;
    let resolveCatalog = (): void => {
      throw new Error("Catalog request did not start");
    };
    context.mocks.api(
      zeroConnectorCatalogContract.status,
      async ({ deferred, respond }) => {
        const catalogDeferred = deferred<void>();
        resolveCatalog = () => {
          catalogDeferred.resolve();
        };
        catalogRequestStarted = true;
        await catalogDeferred.promise;
        return respond(200, {
          connectors: [
            publicConnectorStatusItem({
              slug: "slack",
              label: "Slack",
            }),
          ],
        });
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Connector loading height",
      chatEvents: [
        {
          id: `${threadId}-message`,
          role: "assistant",
          content: connectorUrl,
          runId: `${threadId}-run`,
          createdAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const loadingCard = await screen.findByTestId(
      "connector-action-card-loading",
    );
    expect(loadingCard).toHaveClass("h-[136px]", "sm:h-[88px]");
    await waitFor(() => {
      expect(catalogRequestStarted).toBeTruthy();
    });
    resolveCatalog();

    const connectorCard = await screen.findByTestId("connector-action-card");
    expect(connectorCard).toHaveClass("h-[136px]", "sm:h-[88px]");
    expect(
      screen.queryByTestId("connector-action-card-loading"),
    ).not.toBeInTheDocument();
  });

  it("keeps sent mail card height stable while draft data loads", async () => {
    const threadId = `${THREAD_ID}-mail-loading-height`;
    const mailDraftId = "c0000000-0000-4000-a000-000000000091";
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
    const createdAt = "2026-07-30T10:00:00.000Z";
    let draftRequestStarted = false;
    let resolveDraft = (): void => {
      throw new Error("Draft request did not start");
    };
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({ slug: "gmail", label: "Gmail" }),
    ]);
    context.mocks.api(
      zeroMailContract.getDraft,
      async ({ deferred, respond }) => {
        const draftDeferred = deferred<void>();
        resolveDraft = () => {
          draftDeferred.resolve();
        };
        draftRequestStarted = true;
        await draftDeferred.promise;
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
            subject: MAIL_FOLLOW_UP_SUBJECT,
            body: "Mail body",
            status: "sent",
            detailAvailable: true,
            gmailDraftId: "gmail-draft-id",
            gmailThreadId: "gmail-thread-id",
            gmailMessageId: "gmail-message-id",
            sentGmailMessageId: "gmail-sent-message-id",
            sentAt: createdAt,
            references: [],
            attachments: [],
            createdAt,
            updatedAt: createdAt,
          },
        });
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Mail loading height",
      chatEvents: [
        {
          id: `${threadId}-message`,
          role: "assistant",
          content: mailDraftUrl,
          runId: `${threadId}-run`,
          createdAt,
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
      },
    });

    const loadingCard = await screen.findByTestId("mail-draft-card-loading");
    expect(loadingCard).toHaveClass("h-[76px]");
    await waitFor(() => {
      expect(draftRequestStarted).toBeTruthy();
    });
    resolveDraft();

    await screen.findByText(MAIL_FOLLOW_UP_SUBJECT);
    const mailCard = document.querySelector("[data-mail-draft-card]");
    expect(mailCard).toHaveClass("h-[76px]");
    expect(
      screen.queryByTestId("mail-draft-card-loading"),
    ).not.toBeInTheDocument();
  });

  it("opens a shared mail draft without reloading and refreshes after sending", async () => {
    const user = userEvent.setup({ delay: null });
    const clipboard = context.mocks.browser.clipboardWriteText();
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    const createdAttachmentUrls: string[] = [];
    const revokedAttachmentUrls: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((object) => {
      const url = nativeCreateObjectUrl(object);
      createdAttachmentUrls.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revokedAttachmentUrls.push(url);
      nativeRevokeObjectUrl(url);
    });
    const threadId = "c0000000-0000-4000-a000-000000000010";
    const eventId = "c0000000-0000-4000-a000-000000000011";
    const secondEventId = "c0000000-0000-4000-a000-000000000013";
    const untrustedEventId = "c0000000-0000-4000-a000-000000000017";
    const mailDraftId = "c0000000-0000-4000-a000-000000000012";
    const runId = "d0000000-0000-4000-a000-000000000020";
    const createdAt = "2026-07-14T10:00:00.000Z";
    let draftRequests = 0;
    let sent = false;
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
    const imageBytes = new TextEncoder().encode("mail draft image");
    const pdfBytes = new TextEncoder().encode("mail draft pdf");
    const textBytes = new TextEncoder().encode(
      "Mail attachment decision: ship",
    );
    const mailDraftHtml =
      '<div>Mail body <strong>before</strong></div><p><img src="cid:email-test-illustration" alt="Cheerful envelope illustration"><br>After image</p><hr><ul><li>Mail body after</li></ul><a href="https://example.com/review">Review</a><div><img src="https://images.example.test/signature.png" alt="Sender signature logo" width="96" height="32"><img src="data:image/png;base64,dW5zYWZl" alt="Unsafe signature image"></div>';

    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        slug: "gmail",
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
          to: [
            "recipient@example.com",
            "teammate@example.com",
            "reviewer@example.com",
          ],
          cc: ["copy@example.com"],
          bcc: ["hidden@example.com"],
          subject: "Hello",
          body: "Mail body",
          bodyHtml: mailDraftHtml,
          inlineImages: [
            {
              contentId: "email-test-illustration",
              partId: "2",
              alt: "Cheerful envelope illustration",
            },
          ],
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
              partId: "1",
            },
            {
              filename: "decision.txt",
              contentType: "text/plain",
              size: textBytes.byteLength,
              partId: "3",
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
          to: [
            "recipient@example.com",
            "teammate@example.com",
            "reviewer@example.com",
          ],
          cc: ["copy@example.com"],
          bcc: ["hidden@example.com"],
          subject: "Hello",
          body: "Mail body",
          bodyHtml: mailDraftHtml,
          inlineImages: [
            {
              contentId: "email-test-illustration",
              partId: "2",
              alt: "Cheerful envelope illustration",
            },
          ],
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
              partId: "1",
            },
            {
              filename: "decision.txt",
              contentType: "text/plain",
              size: textBytes.byteLength,
              partId: "3",
            },
          ],
          createdAt,
          updatedAt: "2026-07-14T10:01:00.000Z",
          sentAt: "2026-07-14T10:01:00.000Z",
        },
      });
    });
    context.mocks.http.get(
      "*/api/zero/mail/drafts/:mailDraftId/attachments/:partId",
      ({ params }) => {
        expect(params.mailDraftId).toBe(mailDraftId);
        if (params.partId === "1") {
          return new HttpResponse(pdfBytes, {
            status: 200,
            headers: { "Content-Type": "application/pdf" },
          });
        }
        if (params.partId === "3") {
          return new HttpResponse(textBytes, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        expect(params.partId).toBe("2");
        return new HttpResponse(imageBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Mail card",
      chatEvents: [
        {
          id: eventId,
          role: "assistant",
          content: mailDraftUrl,
          runId,
          createdAt,
        },
        {
          id: secondEventId,
          role: "assistant",
          content: `[Review email](/mail/drafts/${mailDraftId})`,
          runId,
          createdAt: "2026-07-14T10:00:01.000Z",
        },
        {
          id: untrustedEventId,
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
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: false,
      },
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
        within(card).getByText("To: recipient@example.com +2"),
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
    expect(
      within(sidebar).getByRole("heading", { name: "Hello" }),
    ).toBeInTheDocument();
    expect(within(sidebar).queryByText("Message")).toBeNull();
    expect(within(sidebar).getByText("sender@example.com")).toBeInTheDocument();
    expect(
      within(sidebar).getByText(
        /to recipient@example\.com, teammate@example\.com, reviewer@example\.com/u,
      ),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByText(/cc copy@example\.com/u),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByText(/bcc hidden@example\.com/u),
    ).toBeInTheDocument();
    expect(linkByText("Open in Gmail", sidebar)).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/?authuser=sender%40example.com#drafts?compose=gmail-message-id",
    );
    const messageSection = sidebar.querySelector<HTMLElement>(
      "[data-feedback-source]",
    );
    if (!messageSection) {
      throw new Error("Expected mail message section");
    }
    const boldText = within(messageSection).getByText("before");
    expect(boldText.tagName).toBe("STRONG");
    expect(
      within(messageSection).getByText("Mail body after"),
    ).toBeInTheDocument();
    expect(within(messageSection).getByRole("listitem")).toHaveTextContent(
      "Mail body after",
    );
    const reviewLink = queryAllByRoleFast("link", messageSection).find(
      (link) => {
        return link.textContent === "Review";
      },
    );
    expect(reviewLink).toHaveAttribute("href", "https://example.com/review");
    expect(within(sidebar).getByText("report.pdf")).toBeInTheDocument();
    let pdfPreview: HTMLButtonElement | null = null;
    await waitFor(() => {
      pdfPreview = sidebar.querySelector(
        '[aria-label="Open pdf preview for report.pdf"]',
      );
      expect(pdfPreview).toBeInstanceOf(HTMLButtonElement);
    });
    if (!pdfPreview) {
      throw new Error("Expected PDF attachment preview");
    }
    await user.click(pdfPreview);
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(within(lightbox).getByTitle("report.pdf preview")).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:.+#navpanes=0$/u),
    );
    expect(within(lightbox).queryByLabelText("Share")).toBeNull();
    expect(within(lightbox).queryByLabelText("Open in split view")).toBeNull();
    await user.click(within(lightbox).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    });
    const textPreview = await within(sidebar).findByLabelText(
      "Open text preview for decision.txt",
    );
    await user.click(textPreview);
    const textLightbox = await screen.findByTestId("attachment-lightbox");
    await expect(
      within(textLightbox).findByText(/Mail attachment decision: ship/u),
    ).resolves.toBeInTheDocument();
    await user.click(within(textLightbox).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    });
    const inlineImage = await within(messageSection).findByRole("img", {
      name: "Cheerful envelope illustration",
    });
    expect(inlineImage).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:/u),
    );
    const signatureImage = within(messageSection).getByRole("img", {
      name: "Sender signature logo",
    });
    expect(signatureImage).toHaveAttribute(
      "src",
      "https://images.example.test/signature.png",
    );
    expect(signatureImage).toHaveAttribute("width", "96");
    expect(signatureImage).toHaveAttribute("height", "32");
    expect(signatureImage).toHaveAttribute("loading", "lazy");
    expect(signatureImage).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(
      within(messageSection).queryByRole("img", {
        name: "Unsafe signature image",
      }),
    ).toBeNull();
    const attachmentsLabel = within(sidebar).getByText("Attachments");
    const attachmentsSection = attachmentsLabel.parentElement;
    if (!attachmentsSection) {
      throw new Error("Expected mail attachments section");
    }
    expect(within(attachmentsSection).queryByRole("img")).toBeNull();
    expect(
      within(sidebar).queryByText("email-test-illustration.png"),
    ).toBeNull();
    expect(within(sidebar).queryByText(/application\/pdf/u)).toBeNull();
    expect(within(sidebar).queryByText("reply-only@example.com")).toBeNull();
    expect(
      within(sidebar).queryByText("<thread-message@example.com>"),
    ).toBeNull();
    expect(
      within(sidebar).queryByText("<reference-message@example.com>"),
    ).toBeNull();
    expect(within(sidebar).queryByRole("textbox")).not.toBeInTheDocument();
    expect(messageSection).toHaveAttribute("data-feedback-source-type", "mail");
    expect(messageSection).toHaveAttribute(
      "data-feedback-source-id",
      mailDraftId,
    );
    expect(messageSection).toHaveAttribute(
      "data-feedback-source-status",
      "draft",
    );
    expect(messageSection).not.toHaveAttribute("data-feedback-source-sent-id");

    selectMailText(boldText);
    await user.click(await waitForSelectionToolbarButton("Copy"));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual(["before"]);
    });

    selectMailText(within(messageSection).getByRole("listitem"));
    await user.click(await waitForSelectionToolbarButton("Provide feedback"));
    await waitFor(() => {
      const feedbackItem = document.querySelector("[data-feedback-item]");
      expect(feedbackItem).toHaveTextContent("Mail body after");
    });

    expect(draftRequests).toBe(1);
    await user.click(await waitForButtonByText("Send", sidebar));

    await waitFor(() => {
      expect(sent).toBeTruthy();
      expect(screen.getByText("Email sent")).toBeInTheDocument();
    });
    await waitFor(() => {
      sidebar = screen.getByTestId("mail-draft-sidebar");
      expect(within(sidebar).getByText("Sent")).toBeInTheDocument();
    });
    expect(linkByText("Open in Gmail", sidebar)).toHaveAttribute(
      "href",
      "https://mail.google.com/mail/?authuser=sender%40example.com#all/gmail-thread-id",
    );
    expect(queryButtonByText("Send", sidebar)).toBeNull();
    const sentMessageSection = sidebar.querySelector<HTMLElement>(
      "[data-feedback-source]",
    );
    if (!sentMessageSection) {
      throw new Error("Expected sent mail message section");
    }
    expect(sentMessageSection).toHaveAttribute(
      "data-feedback-source-status",
      "sent",
    );
    expect(sentMessageSection).toHaveAttribute(
      "data-feedback-source-sent-id",
      "gmail-sent-message-id",
    );
    expect(draftRequests).toBe(1);

    let liveAttachmentUrls: string[] = [];
    await waitFor(() => {
      liveAttachmentUrls = createdAttachmentUrls.filter((url) => {
        return !revokedAttachmentUrls.includes(url);
      });
      expect(liveAttachmentUrls.length).toBeGreaterThan(0);
    });
    await user.click(within(sidebar).getByLabelText("Close email details"));
    await waitFor(() => {
      expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
      expect(
        liveAttachmentUrls.every((url) => {
          return revokedAttachmentUrls.includes(url);
        }),
      ).toBeTruthy();
    });
  });

  it("renders canonical user text literally and assistant actions on alternate origins", async () => {
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
        slug: "slack",
        label: "Slack",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Alternate production origin",
      chatEvents: [
        {
          id: "msg-user-alternate-production-origin",
          role: "user",
          content: `[User connector link](${canonicalUrl})`,
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
    expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
    expect(
      screen.getByText(`[User connector link](${canonicalUrl})`),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").find((link) => {
        return link.textContent === "User connector link";
      }),
    ).toBeUndefined();
    const untrustedLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent === "Untrusted connector";
    });
    expect(untrustedLink).toHaveAttribute("href", untrustedUrl);
  });

  it("offers follow-up after sending without starting another round", async () => {
    const user = userEvent.setup({ delay: null });
    const scenario = mailFollowUpScenario({
      threadId: "c0000000-0000-4000-a000-000000000041",
      mailDraftId: "c0000000-0000-4000-a000-000000000043",
    });

    detachedSetupPage({
      context,
      path: `/chats/${scenario.threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
      },
    });

    await user.click(await waitForMailDraftCard());
    let sidebar = await screen.findByTestId("mail-draft-sidebar");
    await user.click(await waitForButtonByText("Send", sidebar));

    await expect(screen.findByText("Email sent")).resolves.toBeInTheDocument();
    expect(scenario.sentPrompts).toStrictEqual([]);
    sidebar = screen.getByTestId("mail-draft-sidebar");
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Follow up";
      }),
    ).toHaveLength(2);
    await user.click(await waitForButtonByText("Follow up", sidebar));

    await waitFor(() => {
      expect(scenario.followUpRequests).toStrictEqual([scenario.mailDraftId]);
      expect(scenario.sentPrompts).toStrictEqual([]);
      expect(
        queryAllByRoleFast("button").filter((button) => {
          return button.textContent?.trim() === "Tracking replies";
        }),
      ).toHaveLength(2);
    });
  });

  it("hides follow-up while its rollout switch is disabled", async () => {
    const user = userEvent.setup({ delay: null });
    const scenario = mailFollowUpScenario({
      threadId: "c0000000-0000-4000-a000-000000000044",
      mailDraftId: "c0000000-0000-4000-a000-000000000045",
    });

    detachedSetupPage({
      context,
      path: `/chats/${scenario.threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: false,
      },
    });

    await user.click(await waitForMailDraftCard());
    const sidebar = await screen.findByTestId("mail-draft-sidebar");
    await user.click(await waitForButtonByText("Send", sidebar));
    await expect(screen.findByText("Email sent")).resolves.toBeInTheDocument();

    expect(queryButtonByText("Follow up", document)).toBeNull();
    expect(scenario.followUpRequests).toStrictEqual([]);
  });

  it("keeps the email sent when reply tracking cannot be enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const scenario = mailFollowUpScenario({
      threadId: "c0000000-0000-4000-a000-000000000061",
      mailDraftId: "c0000000-0000-4000-a000-000000000062",
    });
    context.mocks.api(zeroMailContract.createFollowUp, ({ respond }) => {
      return respond(409, {
        error: {
          message: "Failed to enable reply tracking",
          code: "CONFLICT",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${scenario.threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
      },
    });

    await user.click(await waitForMailDraftCard());
    let sidebar = await screen.findByTestId("mail-draft-sidebar");
    await user.click(await waitForButtonByText("Send", sidebar));

    await waitFor(() => {
      expect(screen.getByText("Email sent")).toBeInTheDocument();
    });
    await waitFor(() => {
      sidebar = screen.getByTestId("mail-draft-sidebar");
      expect(within(sidebar).getByText("Sent")).toBeInTheDocument();
    });
    await user.click(await waitForButtonByText("Follow up", sidebar));
    await waitFor(() => {
      expect(
        screen.getByText("Failed to enable reply tracking"),
      ).toBeInTheDocument();
    });
    expect(scenario.sentPrompts).toStrictEqual([]);
  });

  it("does not offer follow-up when the email fails to send", async () => {
    const user = userEvent.setup({ delay: null });
    const scenario = mailFollowUpScenario({
      threadId: "c0000000-0000-4000-a000-000000000081",
      mailDraftId: "c0000000-0000-4000-a000-000000000082",
    });
    context.mocks.api(zeroMailContract.sendDraft, ({ respond }) => {
      return respond(409, {
        error: {
          message: "This mail draft can no longer be sent",
          code: "CONFLICT",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${scenario.threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
      },
    });

    await user.click(await waitForMailDraftCard());
    const sidebar = await screen.findByTestId("mail-draft-sidebar");
    await user.click(await waitForButtonByText("Send", sidebar));

    await waitFor(() => {
      expect(
        screen.getByText("This mail draft can no longer be sent"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Email sent")).toBeNull();
    expect(queryButtonByText("Follow up", document)).toBeNull();
    expect(scenario.sentPrompts).toStrictEqual([]);
  });

  it("starts follow-up from the sent email card in the chat thread", async () => {
    const user = userEvent.setup({ delay: null });
    const scenario = mailFollowUpScenario({
      threadId: "c0000000-0000-4000-a000-000000000071",
      mailDraftId: "c0000000-0000-4000-a000-000000000072",
    });

    detachedSetupPage({
      context,
      path: `/chats/${scenario.threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
      },
    });

    await user.click(await waitForMailDraftCard());
    const sidebar = await screen.findByTestId("mail-draft-sidebar");
    await user.click(await waitForButtonByText("Send", sidebar));

    await waitFor(() => {
      expect(screen.getByText("Email sent")).toBeInTheDocument();
    });
    const closeButton = queryAllByRoleFast(
      "button",
      screen.getByTestId("mail-draft-sidebar"),
    ).find((button) => {
      return button.getAttribute("aria-label") === "Close email details";
    });
    expect(closeButton).toBeDefined();
    if (!closeButton) {
      throw new Error("Close email details button not found");
    }
    await user.click(closeButton);
    await user.click(await waitForButtonByText("Follow up", document));

    await waitFor(() => {
      expect(scenario.followUpRequests).toStrictEqual([scenario.mailDraftId]);
      expect(scenario.sentPrompts).toStrictEqual([]);
    });
  });

  it("keeps mail feedback scoped to the chat that owns the draft in split view", async () => {
    const user = userEvent.setup({ delay: null });
    const leftThreadId = "c0000000-0000-4000-a000-000000000031";
    const rightThreadId = "c0000000-0000-4000-a000-000000000032";
    const mailDraftId = "c0000000-0000-4000-a000-000000000033";
    const createdAt = "2026-07-14T10:00:00.000Z";

    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        slug: "gmail",
        label: "Gmail",
      }),
    ]);
    context.mocks.api(zeroMailContract.getDraft, ({ respond }) => {
      return respond(200, {
        mailDraftId,
        mailDraftUrl: `https://app.vm0.ai/mail/drafts/${mailDraftId}`,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          cc: [],
          bcc: [],
          subject: "Right chat draft",
          body: "Feedback belongs to the right chat.",
          status: "draft",
          detailAvailable: true,
          gmailDraftId: "r-right-chat-draft",
          gmailThreadId: "gmail-right-chat-thread",
          gmailMessageId: "gmail-right-chat-message",
          references: [],
          attachments: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
    });
    mockChatLifecycle(context, {
      threadId: leftThreadId,
      threadTitle: "Left chat",
      chatEvents: [],
    });
    context.mocks.api(
      chatThreadEventsContract.list,
      ({ params, query, respond }) => {
        if (
          params.threadId !== rightThreadId ||
          query.beforeSeqId ||
          query.sinceSeqId
        ) {
          return respond(200, { events: [] });
        }
        return respond(200, {
          events: [
            {
              id: "c0000000-0000-4000-a000-000000000034",
              threadId: rightThreadId,
              eventType: "output.message",
              seqId: 1,
              content: `https://app.vm0.ai/mail/drafts/${mailDraftId}`,
              createdAt,
            },
          ],
        });
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${leftThreadId}?sidebar=${rightThreadId}`,
    });

    await user.click(
      await screen.findByLabelText("Open draft email: Right chat draft"),
    );
    const sidebar = await screen.findByTestId("mail-draft-sidebar");
    expect(sidebar).toHaveAttribute(
      "data-chat-thread-container-id",
      rightThreadId,
    );

    selectMailText(
      within(sidebar).getByText("Feedback belongs to the right chat."),
    );
    await user.click(await waitForSelectionToolbarButton("Provide feedback"));
    const chatThreads = await screen.findAllByLabelText("Chat thread");
    await waitFor(() => {
      expect(
        chatThreads[0]?.querySelector("[data-feedback-item]"),
      ).not.toBeInTheDocument();
      expect(
        chatThreads[1]?.querySelector("[data-feedback-item]"),
      ).toHaveTextContent("Feedback belongs to the right chat.");
    });
  });

  it("switches drafts without reloading a draft when it is reopened", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-000000000023";
    const firstMailDraftId = "c0000000-0000-4000-a000-000000000024";
    const secondMailDraftId = "c0000000-0000-4000-a000-000000000025";
    const runId = "d0000000-0000-4000-a000-000000000028";
    const createdAt = "2026-07-14T10:00:00.000Z";
    let firstDraftRequests = 0;
    let secondDraftRequests = 0;
    let secondSubject = "Second draft";

    context.mocks.api(zeroMailContract.getDraft, ({ params, respond }) => {
      const isSecondDraft = params.mailDraftId === secondMailDraftId;
      if (isSecondDraft) {
        secondDraftRequests += 1;
      } else {
        firstDraftRequests += 1;
      }
      const subject = isSecondDraft ? secondSubject : "First draft";
      return respond(200, {
        mailDraftId: params.mailDraftId,
        mailDraftUrl: `https://app.vm0.ai/mail/drafts/${params.mailDraftId}`,
        mailDraft: {
          version: 3,
          provider: "gmail",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          cc: [],
          bcc: [],
          subject,
          body: `${subject} body`,
          status: "draft",
          detailAvailable: true,
          gmailDraftId: `gmail-${params.mailDraftId}`,
          gmailThreadId: `thread-${params.mailDraftId}`,
          gmailMessageId: `message-${params.mailDraftId}`,
          references: [],
          attachments: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Switch mail drafts",
      chatEvents: [
        {
          id: "c0000000-0000-4000-a000-000000000026",
          role: "assistant",
          content: `https://app.vm0.ai/mail/drafts/${firstMailDraftId}`,
          runId,
          createdAt,
        },
        {
          id: "c0000000-0000-4000-a000-000000000027",
          role: "assistant",
          content: `https://app.vm0.ai/mail/drafts/${secondMailDraftId}`,
          runId,
          createdAt: "2026-07-14T10:00:01.000Z",
        },
      ],
      activeRunIds: [runId],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: false,
      },
    });

    await user.click(
      await screen.findByLabelText("Open draft email: First draft"),
    );
    let sidebar = await screen.findByTestId("mail-draft-sidebar");
    await waitFor(() => {
      expect(within(sidebar).getByText("First draft")).toBeInTheDocument();
    });

    await user.click(
      await screen.findByLabelText("Open draft email: Second draft"),
    );
    await waitFor(() => {
      sidebar = screen.getByTestId("mail-draft-sidebar");
      expect(within(sidebar).getByText("Second draft")).toBeInTheDocument();
    });

    await user.click(within(sidebar).getByLabelText("Close email details"));
    await waitFor(() => {
      expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
    });

    secondSubject = "Updated second draft";
    await user.click(
      await screen.findByLabelText("Open draft email: Second draft"),
    );
    sidebar = await screen.findByTestId("mail-draft-sidebar");
    expect(within(sidebar).getByText("Second draft")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open draft email: Second draft"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Open draft email: Updated second draft"),
    ).toBeNull();

    expect(firstDraftRequests).toBe(1);
    expect(secondDraftRequests).toBe(1);
  });

  it("preserves assistant copy and reconnects an expired connector", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = `${THREAD_ID}-reconnect`;
    const callbackPrompt = "Retry the Gmail draft after reconnecting";
    const connectorUrl = `${window.location.origin}/connectors/gmail/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`;
    const assistantCopy = `Gmail needs to be reconnected. [Reconnect Gmail](${connectorUrl}) to continue creating the draft.`;
    const displayedCopy =
      "Gmail needs to be reconnected. Reconnect Gmail to continue creating the draft.";
    const sentPrompts: string[] = [];
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    let reconnectRequired = true;

    context.mocks.data.connectors([
      connectedConnector({
        slug: "gmail",
        authMethod: "oauth",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
    ]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          publicConnectorStatusItem({
            slug: "gmail",
            label: "Gmail",
            connected: true,
            connectionStatus: reconnectRequired
              ? "reconnect-required"
              : "connected",
            connection: {
              authMethod: "oauth",
              externalUsername: null,
              externalEmail: "sender@example.com",
              reconnectReason: reconnectRequired
                ? "authorization_expired_or_revoked"
                : null,
            },
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
    mockAgentConnectorAuthorizations(["gmail"]);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("gmail");
        expect(body).toStrictEqual({
          authMethod: "oauth",
          agentId: AGENT_ID,
          authorizeAgent: true,
          callbackTarget: "app",
        });
        reconnectRequired = false;
        context.mocks.data.connectors([
          connectedConnector({
            slug: "gmail",
            authMethod: "oauth",
            externalEmail: "sender@example.com",
            updatedAt: "2026-01-01T00:00:01Z",
          }),
        ]);
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/oauth",
        });
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Reconnect connector",
      chatEvents: [
        {
          id: "msg-user-reconnect",
          role: "user",
          content: "Create the Gmail draft",
          runId: "run-reconnect",
          createdAt: "2026-07-24T09:05:10Z",
        },
        {
          id: "msg-assistant-reconnect",
          role: "assistant",
          content: assistantCopy,
          runId: "run-reconnect",
          createdAt: "2026-07-24T09:06:19Z",
        },
      ],
      onSendRequest: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const displayedCopyElement = await screen.findByText(displayedCopy);
    expect(displayedCopyElement).toBeInTheDocument();
    const connectorCard = await screen.findByTestId("connector-action-card");
    const reconnectButton = await waitForButtonByText(
      "Reconnect",
      connectorCard,
    );
    await user.click(reconnectButton);

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://accounts.google.test/oauth",
      );
      expect(sentPrompts).toStrictEqual([callbackPrompt]);
      expect(within(connectorCard).getByText("Authorized")).toBeInTheDocument();
      expect(buttonByText("Authorized", connectorCard)).toBeDisabled();
    });
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
            slug: "github",
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
        enabledConnectorSlugs: authorized ? ["github"] : [],
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
            slug: "github",
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
      chatEvents: [
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
      expect(within(connectorCard).getByText("Authorized")).toBeInTheDocument();
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
            slug: "stripe",
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
        enabledConnectorSlugs: authorized ? ["stripe"] : [],
      });
    });
    context.mocks.api(
      zeroConnectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCalls += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body).toStrictEqual({
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        connected = true;
        authorized = true;
        return respond(
          200,
          connectedConnector({ slug: "stripe", authMethod: "api" }),
        );
      },
    );
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Direct no-auth connector",
      chatEvents: [
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
      expect(within(connectorCard).getByText("Authorized")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("dialog", { name: "Public Stripe" }),
    ).not.toBeInTheDocument();
  });

  it("deletes the shared mail draft without reloading it", async () => {
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
      chatEvents: [
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
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: false,
      },
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
      expect(draftRequests).toBe(1);
      expect(screen.queryByLabelText("Open draft email: Delete me")).toBeNull();
      expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
    });
  });

  it("shows a Gmail reconnect action when mail access is no longer authorized", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-00000000001b";
    const mailDraftId = "c0000000-0000-4000-a000-00000000001c";
    const mailDraftUrl = `https://app.vm0.ai/mail/drafts/${mailDraftId}`;
    const createdAt = "2026-07-14T10:00:00.000Z";
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    const openAuthWindow = context.mocks.browser.open(authWindow);
    const refreshStarted = context.mocks.deferred<void>();
    const completeRefresh = context.mocks.deferred<void>();
    let reconnectRequired = true;
    let pauseReadyRefresh = false;
    let catalogRequests = 0;
    let draftRequests = 0;
    let oauthStartRequests = 0;

    context.mocks.data.connectors([
      connectedConnector({
        slug: "gmail",
        authMethod: "oauth",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
    ]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      catalogRequests += 1;
      return respond(200, {
        connectors: [
          publicConnectorStatusItem({
            slug: "gmail",
            label: "Gmail",
            connected: true,
            connectionStatus: reconnectRequired
              ? "reconnect-required"
              : "connected",
            connection: {
              authMethod: "oauth",
              externalUsername: null,
              externalEmail: "sender@example.com",
              reconnectReason: reconnectRequired
                ? "authorization_expired_or_revoked"
                : null,
            },
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
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        oauthStartRequests += 1;
        expect(params.connectorSlug).toBe("gmail");
        return respond(200, {
          authorizationUrl: "https://accounts.google.test/oauth",
        });
      },
    );
    context.mocks.api(zeroMailContract.getDraft, async ({ respond }) => {
      draftRequests += 1;
      if (pauseReadyRefresh && !reconnectRequired) {
        refreshStarted.resolve();
        await completeRefresh.promise;
      }
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
          subject: "Reconnect required",
          body: "",
          accessStatus: reconnectRequired ? "reconnect" : "ready",
          status: "draft",
          detailAvailable: !reconnectRequired,
          gmailDraftId: "r-reconnect",
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
      threadTitle: "Reconnect Gmail",
      chatEvents: [
        {
          id: "c0000000-0000-4000-a000-00000000001d",
          role: "assistant",
          content: mailDraftUrl,
          createdAt,
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ZeroMailReplyFollowUp]: false,
      },
    });

    const card = await screen.findByLabelText(
      "Reconnect Gmail to access email: Reconnect required",
    );
    expect(within(card).getByText("Need reconnect")).toBeInTheDocument();
    expect(card).toBeEnabled();

    expect(catalogRequests).toBeGreaterThanOrEqual(1);
    expect(hasSubscription("connector:changed")).toBeFalsy();
    expect(draftRequests).toBe(1);

    await user.click(card);
    await waitFor(() => {
      expect(oauthStartRequests).toBe(1);
      expect(openAuthWindow.calls).toHaveLength(1);
      expect(authWindow.location.href).toBe(
        "https://accounts.google.test/oauth",
      );
      expect(within(card).getByText("Reconnecting…")).toBeInTheDocument();
      expect(hasSubscription("connector:changed")).toBeTruthy();
    });

    reconnectRequired = false;
    pauseReadyRefresh = true;
    context.mocks.data.connectors([
      connectedConnector({
        slug: "gmail",
        authMethod: "oauth",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
    ]);
    triggerAblyEvent("connector:changed", {
      connectorSlug: "gmail",
    });

    await refreshStarted.promise;
    const cardRemainedVisible = card.isConnected;
    completeRefresh.resolve();
    expect(cardRemainedVisible).toBeTruthy();

    const refreshedCard = await screen.findByLabelText(
      "Open draft email: Reconnect required",
    );
    expect(within(refreshedCard).getByText("Draft")).toBeInTheDocument();
    await user.click(refreshedCard);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("mail-draft-sidebar")).getByRole("heading", {
          name: "Reconnect required",
        }),
      ).toBeInTheDocument();
    });
    expect(draftRequests).toBe(2);
    expect(hasSubscription("connector:changed")).toBeFalsy();
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
      chatEvents: [
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
    });

    const deletedCard = await screen.findByLabelText(
      "Deleted email: Deleted provider draft",
    );
    expect(deletedCard).toHaveAttribute("aria-disabled", "true");
    expect(deletedCard).not.toHaveAttribute("role", "button");
    await user.click(deletedCard);
    expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
  });

  it("shares connector state across assistant events and confirms permissions", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const connectorAuthorizeUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=slack&ref=github&permission=catalog.analytics%3Aread&action=allow&expiresIn=24h`;
    let capturedPermissionGrantBody: unknown = null;

    context.mocks.data.connectors([
      connectedConnector({
        slug: "github",
        authMethod: "oauth",
        externalUsername: "octocat",
      }),
    ]);
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        slug: "github",
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
        expect(params.connectorSlug).toBe("slack");
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorSlug: "slack",
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
    await user.click(within(connectorCard).getByText("Authorize"));

    await waitFor(() => {
      for (const card of connectorCards) {
        expect(within(card).getByText("Authorized")).toBeInTheDocument();
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
        connectorSlug: "slack",
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

  it("renders and confirms multiple permission cards from one assistant event", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const createPermissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=google-sheets&permission=spreadsheets.create&action=allow&expiresIn=1h`;
    const writePermissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=google-sheets&permission=values.write&action=allow&expiresIn=1h`;
    const capturedPermissionGrantBodies: unknown[] = [];

    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ params, respond }) => {
        expect(params.connectorSlug).toBe("google-sheets");
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorSlug: "google-sheets",
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
            connectorSlug: body.connectorSlug,
            permission: grant.permission,
            action: grant.action,
            expiresAt: isoFromNowMs(
              grant.permission === "spreadsheets.create"
                ? 30 * 60 * 1000
                : 60 * 60 * 1000,
            ),
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-multiple-permissions`,
      threadTitle: "Multiple permission cards",
      chatEvents: [
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
      within(writeCard).queryByText("Expires in 1 hour"),
    ).not.toBeInTheDocument();

    expect(capturedPermissionGrantBodies).toStrictEqual([
      {
        agentId: AGENT_ID,
        connectorSlug: "google-sheets",
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
        connectorSlug: "google-sheets",
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
    const permissionUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=channels.read&action=allow&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`;
    const sentPrompts: {
      prompt: string;
      threadId?: string;
      userMessage?: unknown;
    }[] = [];

    context.mocks.api(
      zeroConnectorCatalogContract.permissions,
      ({ respond }) => {
        return respond(200, {
          permissions: catalogPermissionDetail({
            connectorSlug: "slack",
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
      onSendRequest: ({ prompt, threadId: sentThreadId, userMessage }) => {
        sentPrompts.push({
          prompt,
          threadId: sentThreadId,
          userMessage,
        });
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual([
        {
          prompt: callbackPrompt,
          threadId,
          userMessage: {
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
        slug: "github",
        authMethod: "oauth",
        externalUsername: "octocat",
      }),
    ]);
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        slug: "github",
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
      chatEvents: [
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
    await user.click(await waitForButtonByText("Authorize", connectorCard));

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual([callbackPrompt]);
      expect(within(connectorCard).getByText("Authorized")).toBeInTheDocument();
    });
  });

  it("omits connector action cards when catalog metadata is hidden", async () => {
    const hiddenConnectorAuthorizeUrl = `${window.location.origin}/connectors/github/authorize?agentId=${AGENT_ID}`;
    const visibleConnectorAuthorizeUrl = `${window.location.origin}/connectors/slack/authorize?agentId=${AGENT_ID}`;
    mockConnectorCatalogStatus([
      publicConnectorStatusItem({
        slug: "slack",
        label: "Catalog Slack",
        description: "Catalog Slack server help text",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-hidden-connector-metadata`,
      threadTitle: "Hidden connector metadata",
      chatEvents: [
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
            slug: "future-connector",
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
        enabledConnectorSlugs: authorized ? ["future-connector"] : [],
      });
    });
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("future-connector");
        expect(body.agentId).toBe(AGENT_ID);
        expect(body.authorizeAgent).toBeTruthy();
        connected = true;
        authorized = true;
        return respond(
          200,
          connectedConnector({
            slug: "future-connector",
            authMethod: body.authMethod,
          }),
        );
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-future-connector`,
      threadTitle: "Future connector",
      chatEvents: [
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
      expect(within(connectorCard).getByText("Authorized")).toBeInTheDocument();
    });
  });

  it("fails closed when permission action metadata is hidden", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=hidden-connector&permission=hidden.permission&action=allow&expiresIn=1h`;
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
      chatEvents: [
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
    expect(
      within(permissionCard).queryByTestId("permission-action-card-controls"),
    ).not.toBeInTheDocument();
  });

  it("shows already allowed permission action cards as read-only after refresh", async () => {
    mockNow();
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorSlug: "youtube",
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
      chatEvents: [
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
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorSlug: "youtube",
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
          connectorSlug: "youtube",
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
      chatEvents: [
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
    const permissionDenyUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=admin.analytics%3Aread&action=deny`;
    let applyRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: AGENT_ID,
          connectorSlug: "slack",
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
      chatEvents: [
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
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=youtube&permission=videos.write&action=allow&expiresIn=24h`;
    let grantAllowed = false;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(
        200,
        grantAllowed
          ? [
              {
                agentId: AGENT_ID,
                connectorSlug: "youtube",
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
      chatEvents: [
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
      chatEvents: [
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
      chatEvents: [
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

  it("renders trusted plan links as upgrade cards", async () => {
    const absoluteUrl =
      "https://app.vm0.ai/?settings=billing&billingView=plans";
    const relativeUrl = "/?settings=billing&billingView=plans";
    const untrustedUrl =
      "https://evil.example.test/?settings=billing&billingView=plans";
    const creditUrl = "/?settings=billing&billingView=credits";

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-plan-upgrade`,
      threadTitle: "Plan upgrade cards",
      chatEvents: [
        {
          id: "msg-user-plan-upgrade",
          role: "user",
          content: "Help me unlock video generation",
          runId: "run-plan-upgrade",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-plan-upgrade-card",
          role: "assistant",
          content: [
            absoluteUrl,
            `[Compare plans](${relativeUrl})`,
            `[Untrusted plan](${untrustedUrl})`,
            `[Buy credits](${creditUrl})`,
          ].join("\n\n"),
          runId: "run-plan-upgrade",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-plan-upgrade`,
    });

    const cards = await screen.findAllByTestId("plan-upgrade-card");
    expect(cards).toHaveLength(2);
    expect(
      within(cards[0]!).getByText("Upgrade your workspace"),
    ).toBeInTheDocument();
    expect(
      within(cards[0]!).getByText(
        "Compare plans to unlock paid workspace features and additional credits.",
      ),
    ).toBeInTheDocument();
    for (const card of cards) {
      const comparePlansLink = linkByText("Compare plans", card);
      expect(comparePlansLink).toHaveAttribute("href", relativeUrl);
    }
    expect(linkByText("Untrusted plan", document)).toHaveAttribute(
      "href",
      untrustedUrl,
    );
    expect(linkByText("Buy credits", document)).toHaveAttribute(
      "href",
      creditUrl,
    );
  });

  it("automatically retries permission action loading before showing an error", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=gmail&permission=messages.write&action=allow&expiresIn=1h`;
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
        connectorSlug: "gmail",
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
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=gmail&permission=messages.write&action=allow&expiresIn=1h`;
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
      chatEvents: [
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
    const permissionControls = within(permissionCard).getByTestId(
      "permission-action-card-controls",
    );
    expect(
      within(permissionControls).getByText("Checking permission status..."),
    ).toBeInTheDocument();
    expect(
      queryButtonByText("Checking permission status...", permissionCard),
    ).toBeNull();
    expect(queryButtonByText("Confirm", permissionCard)).toBeNull();

    resolveList();
    const confirmButton = await waitForButtonByText(
      "Confirm",
      permissionControls,
    );
    expect(within(permissionControls).getByText("Confirm")).toBe(confirmButton);
    expect(
      within(permissionControls).getByLabelText("Permission duration"),
    ).toBeInTheDocument();
  });

  it("does not retry non-transient permission action loading failures", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=gmail&permission=messages.write&action=allow&expiresIn=1h`;
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
      chatEvents: [
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
    expect(
      within(permissionCard).queryByTestId("permission-action-card-controls"),
    ).not.toBeInTheDocument();
    expect(listRequests).toBe(1);
  });

  it("shows permission save failures outside the action button", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=gmail&permission=messages.write&action=allow&expiresIn=1h`;
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
      chatEvents: [
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
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=gmail&permission=messages.write&action=allow&expiresIn=1h`;
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`;
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
        connectorSlug: "slack",
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

  it("lets users confirm unknown endpoint permissions from assistant events", async () => {
    mockNow();
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?connectorSlug=cloudflare&permission=${UNKNOWN_PERMISSION_GRANT}&action=allow&expiresIn=1h`;
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
            connectorSlug: body.connectorSlug,
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
      chatEvents: [
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
        connectorSlug: "cloudflare",
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

  it("lets users deny a historical ref permission action", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionDenyUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`;
    let grants: UserPermissionGrantResponse[] = [
      {
        agentId: AGENT_ID,
        connectorSlug: "slack",
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
          connectorSlug: body.connectorSlug,
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
      chatEvents: [
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

  it("renders trusted browser universal links as compact cards with an open action", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "c0000000-0000-4000-a000-000000000080";
    const liveUrl =
      "https://live.browser-use.com/?wss=test-browser-session-token";
    let browser: ZeroBrowserSession = {
      threadId,
      name: "booking",
      status: "active",
      viewerUrl: `https://app.vm0.ai/browsers/${threadId}`,
      liveUrl,
      proxyCountryCode: null,
      timeoutMinutes: 240,
      idleExpiresAt: "2026-07-24T10:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    let browserRequests = 0;
    context.mocks.api(zeroBrowserContract.get, ({ params, respond }) => {
      expect(params.threadId).toBe(threadId);
      browserRequests += 1;
      return respond(200, { browser });
    });
    let leaseRequests = 0;
    context.mocks.api(zeroBrowserContract.leaseByThread, ({ respond }) => {
      leaseRequests += 1;
      return respond(200, { browser });
    });

    const untrustedUrl = `https://evil.example.test/browsers/${threadId}`;
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Managed browser card",
      chatEvents: [
        {
          id: "c0000000-0000-4000-a000-000000000082",
          role: "assistant",
          content: [
            `https://app.vm0.ai/browsers/${threadId}`,
            `[Open browser](/browsers/${threadId})`,
            `[Untrusted browser](${untrustedUrl})`,
          ].join("\n"),
          runId: "c0000000-0000-4000-a000-000000000085",
          createdAt: "2026-07-24T10:00:00.000Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ZeroBrowser]: true },
    });

    await waitFor(() => {
      expect(browserRequests).toBeGreaterThan(0);
    });
    // The message stream shows fixed-height entry points only; the live view is
    // heavy and would resize the transcript as pages load.
    const cards = await waitFor(() => {
      const found = Array.from(
        document.querySelectorAll<HTMLElement>("[data-browser-session-card]"),
      );
      expect(found).toHaveLength(2);
      for (const card of found) {
        expect(card).toHaveTextContent("Cloud browser");
        expect(card).toHaveTextContent("Live");
        expect(card).not.toHaveTextContent("credits charged");
        expect(buttonByText("Open", card)).toHaveAttribute(
          "aria-label",
          "Open booking browser",
        );
      }
      return found;
    });
    expect(
      document.querySelector('iframe[title="Live browser: booking"]'),
    ).toBeNull();

    const firstCard = cards.at(0);
    if (!firstCard) {
      throw new Error("Expected a browser session card");
    }
    await user.click(buttonByText("Open", firstCard));

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.closest("[data-browser-session-sidebar]")).not.toBeNull();
    await waitFor(() => {
      expect(leaseRequests).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(hasSubscription("browserSessionChanged")).toBeTruthy();
    });

    browser = {
      ...browser,
      status: "suspended",
      liveUrl: null,
      idleExpiresAt: null,
      suspendedAt: "2026-07-24T10:12:00.000Z",
      suspensionReason: "idle",
      updatedAt: "2026-07-24T10:12:00.000Z",
    };
    triggerAblyEvent("browserSessionChanged", { threadId });

    await waitFor(() => {
      for (const card of cards) {
        expect(card).toHaveAttribute(
          "data-browser-session-status",
          "suspended",
        );
        expect(card).toHaveTextContent("Stopped");
        expect(card).not.toHaveTextContent("credits charged");
      }
      expect(screen.getByText("Browser not live")).toBeInTheDocument();
      expect(
        document.querySelector('iframe[title="Live browser: booking"]'),
      ).toBeNull();
    });

    const resumedLiveUrl =
      "https://live.browser-use.com/?wss=resumed-browser-session-token";
    browser = {
      ...browser,
      status: "active",
      liveUrl: resumedLiveUrl,
      idleExpiresAt: "2026-07-24T10:22:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      updatedAt: "2026-07-24T10:12:01.000Z",
    };
    triggerAblyEvent("browserSessionChanged", { threadId });

    await waitFor(() => {
      for (const card of cards) {
        expect(card).toHaveAttribute("data-browser-session-status", "active");
        expect(card).toHaveTextContent("Live");
      }
      expect(screen.getByTitle("Live browser: booking")).toHaveAttribute(
        "src",
        resumedLiveUrl,
      );
    });
    expect(
      queryAllByRoleFast("link").find((link) => {
        return link.textContent === "Untrusted browser";
      }),
    ).toHaveAttribute("href", untrustedUrl);
  });
});
