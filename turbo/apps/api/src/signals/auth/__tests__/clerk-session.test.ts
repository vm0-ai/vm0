import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { z } from "zod";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { contractRoute } from "../../route";
import { clerkSessionAuth$ } from "../clerk-session";

const context = testContext();
const c = initContract();

const clerkSessionTestContract = c.router({
  get: {
    method: "GET",
    path: "/__test/clerk-session-auth",
    headers: z.object({
      authorization: z.string().optional(),
    }),
    responses: {
      200: z.union([
        z.object({
          tokenType: z.literal("session"),
          userId: z.string(),
          orgId: z.string().optional(),
          orgRole: z.enum(["admin", "member"]).optional(),
        }),
        z.null(),
      ]),
    },
  },
});

function createAuthClient() {
  const handler$ = computed(async (get) => {
    return { status: 200 as const, body: await get(clerkSessionAuth$) };
  });

  return setupApp({
    context,
    contract: clerkSessionTestContract,
    routesExtend: [
      contractRoute({
        contract: clerkSessionTestContract.get,
        handler: handler$,
      }),
    ],
  });
}

describe("clerkSessionAuth$", () => {
  it("projects authenticated Clerk sessions into API auth context", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: "user_123",
          orgId: "org_123",
          orgRole: "org:admin",
        };
      },
    });

    const client = createAuthClient();
    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toEqual({
      tokenType: "session",
      userId: "user_123",
      orgId: "org_123",
      orgRole: "admin",
    });
    expect(context.mocks.clerk.authenticateRequest).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.authenticateRequest.mock.calls[0]?.[0],
    ).toBeInstanceOf(Request);
    expect(context.mocks.clerk.authenticateRequest.mock.calls[0]?.[1]).toEqual({
      acceptsToken: "session_token",
    });
  });

  it("returns null for unauthenticated requests", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const client = createAuthClient();
    const response = await accept(client.get(), [200]);

    expect(response.body).toBeNull();
  });
});
