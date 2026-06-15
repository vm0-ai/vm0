import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

describe("prompt query parameter injection", () => {
  it("starts a chat draft from a prompt URL", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat?prompt=Set%20up%20a%20daily%20report",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("Set up a daily report");
  });

  it("starts an optimistic chat from the prompt route", async () => {
    let runPrompt: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Build%20a%20launch%20recap&connector=slack",
    });

    await waitFor(() => {
      expect(screen.getByText("Build a launch recap")).toBeInTheDocument();
      expect(runPrompt).toBe("Build a launch recap");
    });
  });
});
