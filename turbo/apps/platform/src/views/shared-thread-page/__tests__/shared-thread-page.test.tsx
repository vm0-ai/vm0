import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const SHARED_THREAD_ID = "30000000-0000-4000-8000-000000000702";

describe("shared thread page", () => {
  it("renders the immutable public DTO without owner or agent identity", async () => {
    context.mocks.api(sharedThreadsContract.get, ({ params, respond }) => {
      expect(params.id).toBe(SHARED_THREAD_ID);
      return respond(200, {
        id: SHARED_THREAD_ID,
        title: "Public launch plan",
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "What should we launch?",
            runIndex: 0,
          },
          {
            messageIndex: 1,
            role: "assistant",
            content: "Launch the **public preview**.",
            runIndex: 0,
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/share/threads/${SHARED_THREAD_ID}`,
      user: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Public launch plan" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("What should we launch?")).toBeInTheDocument();
    expect(screen.getByText("public preview").tagName).toBe("STRONG");
    expect(document.querySelector("[data-role='user']")).toBeInTheDocument();
    expect(
      document.querySelector("[data-role='assistant']"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
  });
});
