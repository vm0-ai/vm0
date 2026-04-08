import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fill, setupPage } from "../../../__tests__/page-helper.ts";

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
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  await setupPage({ context, path: "/agents" });

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

    const avatar = screen.getByAltText("New agent");
    expect(avatar).toBeInTheDocument();
    // Avatar src should be a valid image (imported asset or data URL)
    expect(avatar.getAttribute("src")).toBeTruthy();
  });

  it("should show upload overlay on hover", async () => {
    const user = userEvent.setup();
    mockTeamWithSubagent();
    await openCreateDialog(user);

    const uploadBtn = screen.getByLabelText("Upload avatar");
    expect(uploadBtn).toBeInTheDocument();
  });

  it("should trigger file input when upload button is clicked", async () => {
    const user = userEvent.setup();
    mockTeamWithSubagent();
    await openCreateDialog(user);

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();

    const clickSpy = vi.fn();
    fileInput!.click = clickSpy;

    await user.click(screen.getByLabelText("Upload avatar"));
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("should show custom avatar after upload and switch to delete button", async () => {
    const user = userEvent.setup();
    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({ url: "https://cdn.example.com/custom.png" });
      }),
    );
    await openCreateDialog(user);

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await user.upload(fileInput!, file);

    // After upload, avatar should show custom URL
    await waitFor(() => {
      const avatar = screen.getByAltText("New agent");
      expect(avatar.getAttribute("src")).toBe(
        "https://cdn.example.com/custom.png",
      );
    });

    // Should now show "Remove custom avatar" button instead of upload
    expect(screen.getByLabelText("Remove custom avatar")).toBeInTheDocument();
  });

  it("should revert to a preset avatar after removing custom upload", async () => {
    const user = userEvent.setup();
    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({ url: "https://cdn.example.com/custom.png" });
      }),
    );
    await openCreateDialog(user);

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await user.upload(fileInput!, file);

    await waitFor(() => {
      expect(screen.getByLabelText("Remove custom avatar")).toBeInTheDocument();
    });

    // Click delete — should revert to preset avatar
    await user.click(screen.getByLabelText("Remove custom avatar"));

    await waitFor(() => {
      const avatar = screen.getByAltText("New agent");
      // Should no longer be the custom URL
      expect(avatar.getAttribute("src")).not.toBe(
        "https://cdn.example.com/custom.png",
      );
    });

    // Upload button should be back
    expect(screen.getByLabelText("Upload avatar")).toBeInTheDocument();
  });

  it("should send chosen avatar when creating agent", async () => {
    const user = userEvent.setup();
    let capturedPayload: Record<string, unknown> | null = null;

    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "new-agent-uuid",
            agentId: "new-agent-id",
            ownerId: "test-user-123",
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            permissionPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          permissionPolicies: null,
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
    // Avatar should be a preset string (preset:N)
    expect(capturedPayload!.avatarUrl).toMatch(/^preset:\d+$/);
  });

  it("should send custom avatar URL when creating agent after upload", async () => {
    const user = userEvent.setup();
    let capturedPayload: Record<string, unknown> | null = null;

    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({
          url: "https://cdn.example.com/uploaded.png",
        });
      }),
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "new-agent-uuid",
            agentId: "new-agent-id",
            ownerId: "test-user-123",
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            permissionPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          permissionPolicies: null,
        });
      }),
    );

    await openCreateDialog(user);

    // Upload a custom avatar
    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await user.upload(fileInput!, file);

    await waitFor(() => {
      expect(screen.getByLabelText("Remove custom avatar")).toBeInTheDocument();
    });

    // Fill name and create
    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    await fill(input, "Custom Avatar Agent");
    await user.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.avatarUrl).toBe(
      "https://cdn.example.com/uploaded.png",
    );
  });

  it("should submit via Enter key with avatar", async () => {
    const user = userEvent.setup();
    let capturedPayload: Record<string, unknown> | null = null;

    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "new-agent-uuid",
            agentId: "new-agent-id",
            ownerId: "test-user-123",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            permissionPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          permissionPolicies: null,
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

    expect(capturedPayload!.avatarUrl).toMatch(/^preset:\d+$/);
  });
});
