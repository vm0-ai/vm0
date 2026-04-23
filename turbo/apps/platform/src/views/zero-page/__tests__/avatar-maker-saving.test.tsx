import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/core";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "e0000000-0000-4000-a000-000000000010",
        ownerId: "test-user-123",
        description: "A helpful agent",
        displayName: "My Agent",
        sound: "professional",
        avatarUrl: "preset:0",
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
}

async function openAvatarMaker() {
  detachedSetupPage({ context, path: "/agents/my-agent" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
  click(screen.getByText(/Profile/i));
  await waitFor(() => {
    expect(screen.getByLabelText("Create custom avatar")).toBeInTheDocument();
  });
  click(screen.getByLabelText("Create custom avatar"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("avatar maker - saving state", () => {
  it("resets saving state when onConfirm rejects", async () => {
    mockAPIs();
    server.use(
      // mockApi cannot return 500 (not in contract responses); 404 triggers
      // the same "update failed" error path and is sufficient for this test.
      mockApi(zeroAgentsByIdContract.update, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
    );
    await openAvatarMaker();

    const applyBtn = screen.getByText(/Use this avatar/i);
    expect(applyBtn.closest("button")).not.toBeDisabled();

    click(applyBtn);

    // After the error, the button should become clickable again
    await waitFor(() => {
      const btn = screen.getByText(/Use this avatar/i);
      expect(btn.closest("button")).not.toBeDisabled();
    });
  });
});
