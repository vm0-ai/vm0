import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { appSkeletonVisible$ } from "../../../signals/app-skeleton.ts";

const context = testContext();

const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
const MOCK_THREAD_ID = "thread-blank-test-1";

function mockMemberOnboardingWithChat() {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: true,
        isAdmin: false,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId: MOCK_AGENT_ID,
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
    http.post("*/api/zero/onboarding/complete", () => {
      return HttpResponse.json({ ok: true });
    }),
  );

  const ctrl = mockChatLifecycle({ threadId: MOCK_THREAD_ID });

  return {
    ctrl,
    completeOnboarding: () => {
      server.use(
        http.get("*/api/zero/onboarding/status", () => {
          return HttpResponse.json({
            needsOnboarding: false,
            isAdmin: false,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: MOCK_AGENT_ID,
            defaultAgentMetadata: { displayName: "Zero" },
            defaultAgentSkills: [],
          });
        }),
      );
    },
  };
}

describe("onboarding continue in web → skeleton → chat page (#7902)", () => {
  it("should show skeleton immediately on click, then hide after chat page loads", async () => {
    const user = userEvent.setup();
    const mock = mockMemberOnboardingWithChat();

    await setupPage({ context, path: "/onboarding" });

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Skeleton should be hidden after onboarding page loaded
    expect(context.store.get(appSkeletonVisible$)).toBe(false);

    mock.completeOnboarding();

    await user.click(screen.getByRole("button", { name: /Continue in web/ }));

    // Verify navigation happened and chat page renders
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${MOCK_THREAD_ID}`);
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    // Skeleton should be hidden after chat page setup completes
    expect(context.store.get(appSkeletonVisible$)).toBe(false);

    mock.ctrl.completeRun("Hello!");
  });
});
