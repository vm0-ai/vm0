import { describe, it, expect, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createTestOrg } from "../../../../../../src/__tests__/api-test-helpers";
import { createTestSlackOrgInstallation } from "../../../../../../src/__tests__/db-test-seeders/slack";

const context = testContext();

describe("GET /api/zero/slack/channels", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when no org is active in the session", async () => {
    mockClerk({ userId: uniqueId("slack-no-org"), orgId: null, clerkOrgs: [] });

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when no Slack installation exists for the org", async () => {
    await context.setupUser();

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("returns channels where the bot is a member", async () => {
    const user = await context.setupUser();
    const org = await createTestOrg(uniqueId("org"));

    await createTestSlackOrgInstallation({ orgId: org.id });

    mockClerk({ userId: user.userId, orgId: org.id });

    // Configure conversations.list mock to return channels
    const mockClient = new WebClient();
    const listMock = mockClient.conversations.list as ReturnType<
      typeof import("vitest").vi.fn
    >;
    listMock.mockResolvedValueOnce({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_member: true },
        { id: "C002", name: "random", is_member: true },
        { id: "C003", name: "not-joined", is_member: false },
        { id: "C004", name: "alpha", is_member: true },
      ],
      response_metadata: { next_cursor: "" },
    });

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Should only include channels where is_member is true, sorted alphabetically
    expect(data.channels).toEqual([
      { id: "C004", name: "alpha" },
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
    ]);
  });

  it("handles pagination across multiple pages", async () => {
    const user = await context.setupUser();
    const org = await createTestOrg(uniqueId("org"));

    await createTestSlackOrgInstallation({ orgId: org.id });

    mockClerk({ userId: user.userId, orgId: org.id });

    const mockClient = new WebClient();
    const listMock = mockClient.conversations.list as ReturnType<
      typeof import("vitest").vi.fn
    >;

    // First page with cursor
    listMock.mockResolvedValueOnce({
      ok: true,
      channels: [{ id: "C001", name: "page-one", is_member: true }],
      response_metadata: { next_cursor: "cursor_page2" },
    });

    // Second page (no more cursor)
    listMock.mockResolvedValueOnce({
      ok: true,
      channels: [{ id: "C002", name: "page-two", is_member: true }],
      response_metadata: { next_cursor: "" },
    });

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.channels).toEqual([
      { id: "C001", name: "page-one" },
      { id: "C002", name: "page-two" },
    ]);

    // Verify pagination was used
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no channels have bot membership", async () => {
    const user = await context.setupUser();
    const org = await createTestOrg(uniqueId("org"));

    await createTestSlackOrgInstallation({ orgId: org.id });

    mockClerk({ userId: user.userId, orgId: org.id });

    const mockClient = new WebClient();
    const listMock = mockClient.conversations.list as ReturnType<
      typeof import("vitest").vi.fn
    >;
    listMock.mockResolvedValueOnce({
      ok: true,
      channels: [{ id: "C001", name: "no-bot", is_member: false }],
      response_metadata: { next_cursor: "" },
    });

    const request = new Request(
      "http://localhost:3000/api/zero/slack/channels",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.channels).toEqual([]);
  });
});
