import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as telegramPOST } from "../route";
import {
  createTestRequest,
  ensureOrgRow,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../src/env";

const mockGetUserList = vi.fn();
const mockGetOrganizationMembershipList = vi.fn();
vi.mock("@clerk/nextjs/server", () => {
  return {
    clerkClient: vi.fn(async () => {
      return {
        users: {
          getUserList: mockGetUserList,
          getOrganizationMembershipList: mockGetOrganizationMembershipList,
        },
      };
    }),
    auth: vi.fn(async () => {
      return { userId: null, orgId: null, orgRole: null };
    }),
  };
});

const context = testContext();

function postTelegramState(body: Record<string, unknown>) {
  return telegramPOST(
    createTestRequest("http://localhost:3000/api/test/telegram-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/test/telegram-state", () => {
  let userId: string;
  let orgId: string;
  let email: string;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    reloadEnv();

    mockGetUserList.mockReset();
    mockGetOrganizationMembershipList.mockReset();

    userId = uniqueId("user-telegram-state");
    orgId = uniqueId("org-telegram-state");
    email = `${uniqueId("telegram-state")}@example.com`;

    mockGetUserList.mockResolvedValue({ data: [{ id: userId }] });
    mockGetOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          createdAt: Date.now(),
          organization: {
            id: orgId,
            slug: "telegram-state-org",
            name: "telegram-state-org",
          },
          role: "org:admin",
          publicUserData: { userId },
        },
      ],
    });
    await ensureOrgRow(orgId);
  });

  it("seeds the shared default agent when Telegram preflights race", async () => {
    const botId = uniqueId("123456_TELEGRAM_RACE");
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => {
        return postTelegramState({
          bot_id: botId,
          telegram_user_id: "99001",
          email,
          seed_link: true,
        });
      }),
    );

    const bodies = await Promise.all(
      responses.map(async (response) => {
        if (response.status !== 200) {
          throw new Error(
            `Expected 200, got ${response.status}: ${await response.text()}`,
          );
        }
        return response.json() as Promise<{ default_agent_id: string }>;
      }),
    );

    expect(
      new Set(
        bodies.map((body) => {
          return body.default_agent_id;
        }),
      ).size,
    ).toBe(1);
  });
});
