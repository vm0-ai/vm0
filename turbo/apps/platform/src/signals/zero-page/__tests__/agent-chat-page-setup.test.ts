import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { pathname, search } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

describe("agent chat page setup", () => {
  it("redirects unknown route agents to the default agent chat", async () => {
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/agents/missing-agent/chat?prompt=hello",
      withoutRender: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(
        "/agents/c0000000-0000-4000-a000-000000000001/chat",
      );
      expect(search()).toBe("?prompt=hello");
    });
  });
});
