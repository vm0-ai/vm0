import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import { zeroMailCommand } from "../index";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440001";
const MAIL_DRAFT_ID = "550e8400-e29b-41d4-a716-446655440002";

function stubAgentContext(enabledConnectorSlugs: readonly string[]) {
  return [
    http.get(`http://localhost:3000/api/zero/agents/${AGENT_ID}`, () => {
      return HttpResponse.json({
        agentId: AGENT_ID,
        ownerId: "owner-1",
        description: null,
        displayName: "Mail agent",
        sound: null,
        avatarUrl: null,
      });
    }),
    http.get(
      `http://localhost:3000/api/zero/agents/${AGENT_ID}/user-connectors`,
      () => {
        return HttpResponse.json({
          enabledConnectorSlugs: [...enabledConnectorSlugs],
        });
      },
    ),
  ];
}

function mailCatalog() {
  return stubConnectorCatalogStatus([
    catalogStatusItem({
      connectorSlug: "gmail",
      label: "Gmail",
      authMethods: [authCodeMethod()],
      connected: true,
      connectionStatus: "connected",
      connection: {
        authMethod: "oauth",
        externalUsername: null,
        externalEmail: "sender@example.com",
        reconnectReason: null,
      },
    }),
    catalogStatusItem({
      connectorSlug: "outlook-mail",
      label: "Outlook Mail",
      authMethods: [authCodeMethod()],
    }),
  ]);
}

describe("zero mail", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("ZERO_AGENT_ID", AGENT_ID);
    vi.stubEnv("ZERO_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("lists agent-authorized mail accounts and returns a connect link", async () => {
    server.use(mailCatalog(), ...stubAgentContext(["gmail"]));

    await zeroMailCommand.parseAsync(["node", "cli", "list"]);

    const listOutput = mockConsoleLog.mock.calls.flat().join("\n");
    expect(listOutput).toContain("gmail");
    expect(listOutput).toContain("sender@example.com");
    expect(listOutput).toContain("ready");
    expect(listOutput).toContain("outlook");
    expect(listOutput).toContain("connect");

    mockConsoleLog.mockClear();
    await zeroMailCommand.parseAsync([
      "node",
      "cli",
      "connect",
      "outlook",
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        provider: "outlook",
        action: "connect",
        url: `http://localhost:3000/connectors/outlook-mail/connect?agentId=${AGENT_ID}`,
      },
    );
  });

  it("links an existing Gmail draft and prints only the review URL", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/zero/mail/drafts/link",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-zero-token",
          );
          expect(await request.json()).toStrictEqual({
            threadId: THREAD_ID,
            agentId: AGENT_ID,
            gmailDraftId: "r-test-draft",
          });
          return HttpResponse.json(
            {
              mailDraftId: MAIL_DRAFT_ID,
              mailDraftUrl: `https://app.vm0.ai/mail/drafts/${MAIL_DRAFT_ID}`,
            },
            { status: 200 },
          );
        },
      ),
    );

    await zeroMailCommand.parseAsync(["node", "cli", "link", "r-test-draft"]);

    expect(mockConsoleLog).toHaveBeenCalledOnce();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `https://app.vm0.ai/mail/drafts/${MAIL_DRAFT_ID}`,
    );
  });

  it("adds a callback prompt to the review URL for a single draft", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/mail/drafts/link", () => {
        return HttpResponse.json(
          {
            mailDraftId: MAIL_DRAFT_ID,
            mailDraftUrl: `https://app.vm0.ai/mail/drafts/${MAIL_DRAFT_ID}`,
          },
          { status: 200 },
        );
      }),
    );

    await zeroMailCommand.parseAsync([
      "node",
      "cli",
      "link",
      "r-test-draft",
      "--callback-prompt",
      "Confirm the email was sent",
    ]);

    const reviewUrl = new URL(String(mockConsoleLog.mock.calls[0]?.[0]));
    expect(reviewUrl.pathname).toBe(`/mail/drafts/${MAIL_DRAFT_ID}`);
    expect(reviewUrl.searchParams.get("agentId")).toBe(AGENT_ID);
    expect(reviewUrl.searchParams.get("threadId")).toBe(THREAD_ID);
    expect(reviewUrl.searchParams.get("callbackPrompt")).toBe(
      "Confirm the email was sent",
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "end the current turn",
    );
  });
});
