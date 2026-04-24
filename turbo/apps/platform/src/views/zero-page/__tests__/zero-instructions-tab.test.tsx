/**
 * Views tests for zero-instructions-tab.tsx and tiptap-instructions-editor.tsx
 * Tests loading/error states, unsaved changes handling, rich text rendering,
 * toolbar formatting actions, and bubble menu behavior.
 *
 * Entry point: setupPage({ context, path: "/agents/my-agent?tab=instructions" })
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/core/contracts/zero-agents";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  vi.clearAllMocks();
});

function mockAPIs(instructionsContent: string | null = null) {
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
      id: "agent-detail-id",
      displayName: "My Agent",
      description: "A helpful agent",
      sound: null,
      avatarUrl: null,
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
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, {
        content: instructionsContent,
        filename: null,
      });
    }),
  );
}

async function openInstructionsTab(instructionsContent: string | null = null) {
  mockAPIs(instructionsContent);
  detachedSetupPage({ context, path: "/agents/my-agent?tab=instructions" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "My Agent" }),
    ).toBeInTheDocument();
  });
}

describe("zero instructions tab - display", () => {
  it("shows fetch error state when instructions API fails (PREF-D-017)", async () => {
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
        id: "agent-detail-id",
        displayName: "My Agent",
        description: "A helpful agent",
        sound: null,
        avatarUrl: null,
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
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
      // mockApi cannot be used here: 500 is not declared in zeroAgentInstructionsContract.responses,
      // so this raw handler is the only way to simulate a server error for this test.
      http.get("*/api/zero/agents/:id/instructions", () => {
        return HttpResponse.json(
          { error: { message: "Internal server error", code: "SERVER_ERROR" } },
          { status: 500 },
        );
      }),
    );

    detachedSetupPage({ context, path: "/agents/my-agent?tab=instructions" });

    // When the instructions fetch fails, an error message from the API appears
    await waitFor(() => {
      expect(screen.getByText("Internal server error")).toBeInTheDocument();
    });
  });

  it("shows editor placeholder attribute on empty instructions (PREF-D-019)", async () => {
    await openInstructionsTab(null);

    await waitFor(() => {
      const editorEl = document.querySelector("[data-placeholder]");
      expect(editorEl).toHaveAttribute(
        "data-placeholder",
        "Write instructions for your agent...",
      );
    });
  });

  it("shows unsaved changes bar with Discard and Save when editor is dirty (PREF-D-020)", async () => {
    await openInstructionsTab();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    click(editorEl);
    await user.type(editorEl, "edited content");

    // After typing, the unsaved changes bar should show Discard and Save buttons
    await waitFor(() => {
      expect(screen.getByText(/Discard/i)).toBeInTheDocument();
      expect(screen.getByText(/^Save$/i)).toBeInTheDocument();
    });
  });

  it("calls discard and removes unsaved changes bar (PREF-D-021)", async () => {
    await openInstructionsTab();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    click(editorEl);
    await user.type(editorEl, "some edit");

    await waitFor(() => {
      expect(screen.getByText(/Discard/i)).toBeInTheDocument();
    });
    click(screen.getByText(/Discard/i));

    // After discarding, the unsaved bar should disappear
    await waitFor(() => {
      expect(screen.queryByText(/Discard/i)).not.toBeInTheDocument();
    });
  });

  it("calls save API when Save button is clicked (PREF-D-022)", async () => {
    let putCallCount = 0;
    server.use(
      mockApi(zeroAgentInstructionsContract.update, ({ respond }) => {
        putCallCount++;
        return respond(200, {
          agentId: "e0000000-0000-4000-a000-000000000010",
          ownerId: "test-user-123",
          description: "A helpful agent",
          displayName: "My Agent",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
    );

    await openInstructionsTab();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    click(editorEl);
    await user.type(editorEl, "my instructions");

    await waitFor(() => {
      expect(screen.getByText(/^Save$/i)).toBeInTheDocument();
    });
    click(screen.getByText(/^Save$/i));

    await waitFor(() => {
      expect(putCallCount).toBe(1);
    });
  });
});

describe("zero instructions tab - rich text rendering", () => {
  it("renders bold markdown content as strong element (PREF-D-023)", async () => {
    await openInstructionsTab("**bold text**");

    await waitFor(() => {
      expect(document.querySelector("strong")).toBeInTheDocument();
    });
  });

  it("renders a contenteditable editor area (PREF-D-027)", async () => {
    await openInstructionsTab();

    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
  });
});

describe("zero instructions tab - bubble menu toolbar", () => {
  async function renderWithSelection(content: string) {
    await openInstructionsTab(content);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    await user.click(editorEl);
    await user.keyboard("{Control>}a{/Control}");
    return { user, editorEl };
  }

  it("bold button applies bold formatting to selection (PREF-D-028)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Bold")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Bold"));

    await waitFor(() => {
      expect(document.querySelector("strong")).toBeInTheDocument();
    });
  });

  it("italic button applies italic formatting to selection (PREF-D-029)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Italic")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Italic"));

    await waitFor(() => {
      expect(document.querySelector("em")).toBeInTheDocument();
    });
  });

  it("strikethrough button applies strikethrough formatting (PREF-D-030)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Strikethrough")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Strikethrough"));

    await waitFor(() => {
      expect(document.querySelector("s")).toBeInTheDocument();
    });
  });

  it("inline code button applies code formatting (PREF-D-031)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Inline code")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Inline code"));

    await waitFor(() => {
      expect(document.querySelector("code")).toBeInTheDocument();
    });
  });

  it("heading 1 button applies h1 heading (PREF-D-032)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Heading 1")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Heading 1"));

    await waitFor(() => {
      expect(document.querySelector("h1")).toBeInTheDocument();
    });
  });

  it("heading 2 button applies h2 heading (PREF-D-033)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Heading 2")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Heading 2"));

    await waitFor(() => {
      expect(document.querySelector("h2")).toBeInTheDocument();
    });
  });

  it("heading 3 button applies h3 heading (PREF-D-034)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Heading 3")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Heading 3"));

    await waitFor(() => {
      expect(document.querySelector("h3")).toBeInTheDocument();
    });
  });

  it("bullet list button creates unordered list (PREF-D-035)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Bullet list")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Bullet list"));

    await waitFor(() => {
      expect(document.querySelector("ul")).toBeInTheDocument();
    });
  });

  it("ordered list button creates numbered list (PREF-D-036)", async () => {
    const { user } = await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Ordered list")).toBeInTheDocument();
    });
    await user.click(screen.getByTitle("Ordered list"));

    await waitFor(() => {
      expect(document.querySelector("ol")).toBeInTheDocument();
    });
  });

  it("bubble menu appears on text selection (PREF-D-037)", async () => {
    await renderWithSelection("Hello world");

    await waitFor(() => {
      expect(screen.getByTitle("Bold")).toBeInTheDocument();
      expect(screen.getByTitle("Italic")).toBeInTheDocument();
      expect(screen.getByTitle("Strikethrough")).toBeInTheDocument();
      expect(screen.getByTitle("Inline code")).toBeInTheDocument();
    });
  });
});
