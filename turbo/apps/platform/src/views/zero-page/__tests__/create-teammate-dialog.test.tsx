import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  type ZeroAgentRequest,
  zeroAgentsMainContract,
  zeroAgentInstructionsContract,
} from "@vm0/core";

const context = testContext();

function mockTeamWithSubagent() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
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
          displayName: "Research Agent",
          description: "Finds info",
          sound: null,
          avatarUrl: "preset:2",
          headVersionId: "version_2",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ]);
    }),
  );
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  detachedSetupPage({ context, path: "/agents" });

  await waitFor(() => {
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
  });

  await user.click(screen.getByText("New agent"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("create agent dialog - avatar", () => {
  it("should show a preset avatar when dialog opens", async () => {
    const user = userEvent.setup();
    mockTeamWithSubagent();
    await openCreateDialog(user);

    const avatar = screen.getByRole("img", { name: "New agent" });
    expect(avatar).toBeInTheDocument();
  });

  it("should send chosen avatar when creating agent", async () => {
    const user = userEvent.setup();
    let capturedPayload: ZeroAgentRequest | null = null;

    mockTeamWithSubagent();
    server.use(
      mockApi(zeroAgentsMainContract.create, ({ body, respond }) => {
        capturedPayload = body;
        return respond(201, {
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: body.displayName ?? null,
          sound: null,
          avatarUrl: body.avatarUrl ?? null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
      mockApi(zeroAgentInstructionsContract.update, ({ respond }) => {
        return respond(200, {
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
    );

    await openCreateDialog(user);

    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    await fill(input, "My New Agent");
    await user.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.displayName).toBe("My New Agent");
    // Avatar should be an SVG config string (svg:r1s0h3c2f1d)
    expect(capturedPayload!.avatarUrl).toMatch(/^svg:r\d/);
  });

  it("should submit via Enter key with avatar", async () => {
    const user = userEvent.setup();
    let capturedPayload: ZeroAgentRequest | null = null;

    mockTeamWithSubagent();
    server.use(
      mockApi(zeroAgentsMainContract.create, ({ body, respond }) => {
        capturedPayload = body;
        return respond(201, {
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: body.avatarUrl ?? null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
      mockApi(zeroAgentInstructionsContract.update, ({ respond }) => {
        return respond(200, {
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
    );

    await openCreateDialog(user);

    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    await fill(input, "Enter Agent");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.avatarUrl).toMatch(/^svg:r\d/);
  });
});
