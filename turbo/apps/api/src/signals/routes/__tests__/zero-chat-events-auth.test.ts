import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();

function client() {
  return setupApp({ context })(chatEventsContract);
}

describe("POST /api/zero/chat/events authorization", () => {
  it("rejects a zero token without chat-event:write", async () => {
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent-run:write"],
      iat: seconds,
      exp: seconds + 60,
    });
    const prompt = "Send from Zero CLI";

    const response = await accept(
      client().send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: randomUUID(),
          prompt,
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
