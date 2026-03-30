import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

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

async function openCreateDialog() {
  await setupPage({ context, path: "/team" });

  await waitFor(() => {
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
  });

  fireEvent.click(screen.getByText("Create teammate"));
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("create teammate dialog - avatar", () => {
  it("should show a preset avatar when dialog opens", async () => {
    mockTeamWithSubagent();
    await openCreateDialog();

    const avatar = screen.getByAltText("New teammate");
    expect(avatar).toBeInTheDocument();
    // Avatar src should be a valid image (imported asset or data URL)
    expect(avatar.getAttribute("src")).toBeTruthy();
  });

  it("should show upload overlay on hover", async () => {
    mockTeamWithSubagent();
    await openCreateDialog();

    const uploadBtn = screen.getByRole("button", { name: "Upload avatar" });
    expect(uploadBtn).toBeInTheDocument();
  });

  it("should trigger file input when upload button is clicked", async () => {
    mockTeamWithSubagent();
    await openCreateDialog();

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();

    const clickSpy = vi.fn();
    fileInput!.click = clickSpy;

    fireEvent.click(screen.getByRole("button", { name: "Upload avatar" }));
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("should show custom avatar after upload and switch to delete button", async () => {
    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({ url: "https://cdn.example.com/custom.png" });
      }),
    );
    await openCreateDialog();

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await act(() => {
      fireEvent.change(fileInput!, { target: { files: [file] } });
    });

    // After upload, avatar should show custom URL
    await waitFor(() => {
      const avatar = screen.getByAltText("New teammate");
      expect(avatar.getAttribute("src")).toBe(
        "https://cdn.example.com/custom.png",
      );
    });

    // Should now show "Remove custom avatar" button instead of upload
    expect(
      screen.getByRole("button", { name: "Remove custom avatar" }),
    ).toBeInTheDocument();
  });

  it("should revert to a preset avatar after removing custom upload", async () => {
    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/uploads", () => {
        return HttpResponse.json({ url: "https://cdn.example.com/custom.png" });
      }),
    );
    await openCreateDialog();

    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await act(() => {
      fireEvent.change(fileInput!, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Remove custom avatar" }),
      ).toBeInTheDocument();
    });

    // Click delete — should revert to preset avatar
    fireEvent.click(
      screen.getByRole("button", { name: "Remove custom avatar" }),
    );

    await waitFor(() => {
      const avatar = screen.getByAltText("New teammate");
      // Should no longer be the custom URL
      expect(avatar.getAttribute("src")).not.toBe(
        "https://cdn.example.com/custom.png",
      );
    });

    // Upload button should be back
    expect(
      screen.getByRole("button", { name: "Upload avatar" }),
    ).toBeInTheDocument();
  });

  it("should send chosen avatar when creating agent", async () => {
    let capturedPayload: Record<string, unknown> | null = null;

    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "new-agent-uuid",
            agentId: "new-agent-id",
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: null,
        });
      }),
    );

    await openCreateDialog();

    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    fireEvent.change(input, { target: { value: "My New Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.displayName).toBe("My New Agent");
    // Avatar should be a preset string (preset:N)
    expect(capturedPayload!.avatarUrl).toMatch(/^preset:\d+$/);
  });

  it("should send custom avatar URL when creating agent after upload", async () => {
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
            description: null,
            displayName: capturedPayload.displayName ?? null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: null,
        });
      }),
    );

    await openCreateDialog();

    // Upload a custom avatar
    const dialog = screen.getByRole("dialog");
    const fileInput =
      dialog.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["img"], "avatar.png", { type: "image/png" });

    await act(() => {
      fireEvent.change(fileInput!, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Remove custom avatar" }),
      ).toBeInTheDocument();
    });

    // Fill name and create
    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    fireEvent.change(input, { target: { value: "Custom Avatar Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.avatarUrl).toBe(
      "https://cdn.example.com/uploaded.png",
    );
  });

  it("should submit via Enter key with avatar", async () => {
    let capturedPayload: Record<string, unknown> | null = null;

    mockTeamWithSubagent();
    server.use(
      http.post("*/api/zero/agents", async ({ request }) => {
        capturedPayload = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            name: "new-agent-uuid",
            agentId: "new-agent-id",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: capturedPayload.avatarUrl ?? null,
            connectors: [],
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/zero/agents/new-agent-id/instructions", () => {
        return HttpResponse.json({
          name: "new-agent-uuid",
          agentId: "new-agent-id",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: null,
        });
      }),
    );

    await openCreateDialog();

    const input = screen.getByPlaceholderText("e.g. Research Assistant");
    fireEvent.change(input, { target: { value: "Enter Agent" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(capturedPayload).toBeTruthy();
    });

    expect(capturedPayload!.avatarUrl).toMatch(/^preset:\d+$/);
  });
});
