import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

function mockAPIs() {
  setMockTeam([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "sub-agent-1",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: "professional",
      avatarUrl: "preset:0",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  server.use(
    http.get("*/api/zero/agents/my-agent", () => {
      return HttpResponse.json({
        name: "my-agent",
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: "professional",
        avatarUrl: "preset:0",
        connectors: [],
        permissionPolicies: null,
      });
    }),
    http.get("*/api/zero/agents/:name/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
  );
}

async function openAvatarMaker(user: ReturnType<typeof userEvent.setup>) {
  detachedSetupPage({ context, path: "/agents/my-agent" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
  await user.click(screen.getByText(/Profile/i));
  await waitFor(() => {
    expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
  });
  await user.click(screen.getByLabelText("Create custom avatar"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("avatar maker - saving state", () => {
  it("resets saving state when onConfirm rejects", async () => {
    const user = userEvent.setup();
    mockAPIs();
    server.use(
      http.put("*/api/zero/agents/my-agent", () => {
        return HttpResponse.json(null, { status: 500 });
      }),
    );
    await openAvatarMaker(user);

    const applyBtn = screen.getByText(/Use this avatar/i);
    expect(applyBtn.closest("button")).not.toBeDisabled();

    await user.click(applyBtn);

    // After the error, the button should become clickable again
    await waitFor(() => {
      const btn = screen.getByText(/Use this avatar/i);
      expect(btn.closest("button")).not.toBeDisabled();
    });
  });
});
