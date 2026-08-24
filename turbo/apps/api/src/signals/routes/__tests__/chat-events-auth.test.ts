import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { chatEventsRoutes } from "../chat-events";

const context = testContext();

function client() {
  return setupApp({ context, routes: chatEventsRoutes })(chatEventsContract);
}

describe("POST /api/zero/chat/events authorization", () => {
  it("rejects an agent token without chat-event:write", async () => {
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });
    const prompt = "Send from Okou CLI";

    const response = await accept(
      client().send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: randomUUID(),
          prompt,
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: chat-event:write",
        code: "FORBIDDEN",
      },
    });
  });
});
