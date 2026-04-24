import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { chatThreadByIdContract, chatThreadMessagesContract } from "@vm0/core";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { server } from "../../../mocks/server.ts";
import { pathname, search } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

describe("chat page setup", () => {
  it("redirects missing chat threads to the default agent chat", async () => {
    server.use(
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/chats/123?source=legacy",
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${DEFAULT_AGENT_ID}/chat`);
      expect(search()).toBe("?source=legacy");
    });
  });
});
