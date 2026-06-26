import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

describe("POST /api/zero/uploads/html-dom-edit-snapshot", () => {
  it("uploads the HTML snapshot through the API runtime", async () => {
    const userId = `user_${randomUUID()}`;
    const html = "<!doctype html><html><body><h1>Title</h1></body></html>";
    context.mocks.s3.send.mockResolvedValue({});
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.htmlDomEditSnapshot({
        body: {
          filename: "my edited page.html",
          html,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "my_edited_page.html",
      contentType: "text/html",
      size: new TextEncoder().encode(html).byteLength,
    });
    expect(response.body.url).toBe(
      `https://cdn.vm7.io/artifacts/${userId}/${response.body.id}/my_edited_page.html`,
    );

    const input = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(input).toMatchObject({
      Bucket: "test-user-artifacts",
      Body: html,
      ContentType: "text/html",
    });
    expect(input.Key).toBe(
      `artifacts/${userId}/${response.body.id}/my_edited_page.html`,
    );
  });
});
