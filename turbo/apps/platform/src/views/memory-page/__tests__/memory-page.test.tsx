import { screen, waitFor, within } from "@testing-library/react";
import {
  MEMORY_ACTIVITY_DEFAULT_LIMIT,
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockMemory } from "../../../mocks/handlers/api-memory.ts";
import { setMockMemoryActivity } from "../../../mocks/handlers/api-memory-activity.ts";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();
const mockApi = createMockApi(context);
type MemoryActivityDiff =
  MemoryActivityResponse["entries"][number]["items"][number]["diff"];
type MemoryActivityEntry = MemoryActivityResponse["entries"][number];

async function clickTab(name: string): Promise<void> {
  const tab = await waitFor(() => {
    const found = queryAllByRoleFast("tab").find((element) => {
      return element.textContent?.includes(name);
    });
    expect(found).toBeDefined();
    return found!;
  });
  click(tab);
}

function addedDiff(text: string): MemoryActivityDiff {
  return {
    format: "line",
    beforeExists: false,
    afterExists: true,
    truncated: false,
    stats: { added: 1, removed: 0 },
    hunks: [
      {
        beforeStartLine: null,
        afterStartLine: 1,
        lines: [{ op: "add", beforeLine: null, afterLine: 1, text }],
      },
    ],
  };
}

function updatedDiff(
  beforeText: string,
  afterText: string,
): MemoryActivityDiff {
  return {
    format: "line",
    beforeExists: true,
    afterExists: true,
    truncated: false,
    stats: { added: 1, removed: 1 },
    hunks: [
      {
        beforeStartLine: 1,
        afterStartLine: 1,
        lines: [
          { op: "remove", beforeLine: 1, afterLine: null, text: beforeText },
          { op: "add", beforeLine: null, afterLine: 1, text: afterText },
        ],
      },
    ],
  };
}

function memoryActivityEntry({
  date,
  summary,
  toVersionId,
  filePath,
}: {
  readonly date: string;
  readonly summary: string;
  readonly toVersionId: string;
  readonly filePath: string;
}): MemoryActivityEntry {
  return {
    date,
    summary,
    fromVersionId: null,
    toVersionId,
    items: [
      {
        filePath,
        diff: addedDiff(summary),
      },
    ],
  };
}

function setupMemoryPage(): void {
  setMockMemory({
    exists: true,
    name: "memory",
    size: 80,
    fileCount: 3,
    updatedAt: "2024-01-01T00:00:00Z",
    // "context.md" sorts before "MEMORY.md" alphabetically, so it proves the
    // MEMORY.md pin (rather than plain alphabetical ordering).
    files: [
      { path: "context.md", size: 20 },
      { path: "MEMORY.md", size: 30 },
      { path: "scratch.txt", size: 30 },
    ],
    fileContents: [
      { path: "context.md", content: "Context note." },
      { path: "MEMORY.md", content: "# Memory Index\n\nThings I know." },
      { path: "scratch.txt", content: "Plain scratch note." },
    ],
  });

  detachedSetupPage({
    context,
    path: "/memory",
    featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
  });
}

describe("memory page", () => {
  it("redirects to home when MemoryViewer is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: false },
    });

    await waitFor(() => {
      expect(context.store.get(pathname$)).not.toBe("/memory");
    });
  });

  it("shows an empty state when there is no memory", async () => {
    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No updates yet")).toBeInTheDocument();
    });

    await clickTab("Memory files");

    await waitFor(() => {
      expect(screen.getByText("No memory yet")).toBeInTheDocument();
    });
  });

  it("defaults to the Updates tab and renders the daily activity timeline", async () => {
    setMockMemoryActivity({
      entries: [
        {
          date: "2024-03-02",
          summary:
            "**Changed memory**\n- Zero learned the deployment preference for blue-green deploys.\n\n**How Zero will use this**\n- Zero should apply blue-green deployment context in future release work.",
          fromVersionId: "v1",
          toVersionId: "v2",
          items: [
            {
              filePath: "deploy.md",
              diff: addedDiff("Use blue-green deploys"),
            },
            {
              filePath: "setup.md",
              diff: updatedDiff("old setup", "new setup"),
            },
          ],
        },
      ],
      nextCursor: null,
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    const summary = await waitFor(() => {
      const element = screen.getByText(
        "Zero learned the deployment preference for blue-green deploys.",
      );
      expect(element).toBeInTheDocument();
      return element;
    });

    const updateCard = summary.closest("section");
    if (updateCard === null) {
      throw new Error("Missing memory update card");
    }
    const markdownRoot = updateCard.querySelector(".wmde-markdown");
    if (!(markdownRoot instanceof HTMLElement)) {
      throw new Error("Missing markdown summary root");
    }
    expect(updateCard).toHaveClass("shrink-0");
    expect(screen.getByText("Changed memory")).toBeInTheDocument();
    expect(screen.getByText("How Zero will use this")).toBeInTheDocument();
    expect(screen.queryByText("**Changed memory**")).not.toBeInTheDocument();
    expect(screen.getByText("deploy.md")).toBeInTheDocument();
    expect(screen.getByText("setup.md")).toBeInTheDocument();
    expect(screen.queryByText("Deploy preference")).not.toBeInTheDocument();
    expect(screen.queryByText("Updated")).not.toBeInTheDocument();
    expect(updateCard).toHaveTextContent("+1");
    expect(updateCard).toHaveTextContent("-1");

    // Evidence is hidden until the item is expanded.
    expect(screen.queryByText("new setup")).not.toBeInTheDocument();

    const updatedItem = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("setup.md");
    });
    expect(updatedItem).toBeDefined();
    click(updatedItem!);

    await waitFor(() => {
      expect(screen.getByText("new setup")).toBeInTheDocument();
    });
    expect(screen.getByText("old setup")).toBeInTheDocument();
    const diff = screen.getByLabelText("Memory diff");
    expect(within(diff).getByText("-")).toBeInTheDocument();
    expect(within(diff).getByText("+")).toBeInTheDocument();
  });

  it("shows an Updates-shaped skeleton while the default tab is loading", async () => {
    server.use(
      mockApi(zeroMemoryActivityContract.get, ({ never }) => {
        return never();
      }),
    );

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("memory-updates-loading")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("memory-loading")).not.toBeInTheDocument();
  });

  it("loads more daily activity entries when a next cursor is available", async () => {
    const firstEntry = memoryActivityEntry({
      date: "2024-03-02",
      summary: "First page update",
      toVersionId: "v2",
      filePath: "first.md",
    });
    const secondEntry = memoryActivityEntry({
      date: "2024-03-01",
      summary: "Second page update",
      toVersionId: "v1",
      filePath: "second.md",
    });
    server.use(
      mockApi(zeroMemoryActivityContract.get, ({ query, respond }) => {
        expect(query.limit).toBe(MEMORY_ACTIVITY_DEFAULT_LIMIT);
        if (query.cursor === "2024-03-02") {
          return respond(200, { entries: [secondEntry], nextCursor: null });
        }
        expect(query.cursor).toBeUndefined();
        return respond(200, {
          entries: [firstEntry],
          nextCursor: "2024-03-02",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("First page update")).toBeInTheDocument();
    });
    expect(screen.queryByText("Second page update")).not.toBeInTheDocument();

    const loadMoreButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Load more");
    });
    expect(loadMoreButton).toBeDefined();
    click(loadMoreButton!);

    await waitFor(() => {
      expect(screen.getByText("Second page update")).toBeInTheDocument();
    });
    expect(screen.getByText("First page update")).toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent?.includes("Load more");
      }),
    ).toBeFalsy();
  });

  it("dev-refreshes memory summaries and reloads the activity timeline", async () => {
    const beforeEntry = memoryActivityEntry({
      date: "2024-03-02",
      summary: "Before refresh",
      toVersionId: "v2",
      filePath: "before.md",
    });
    const afterEntry = memoryActivityEntry({
      date: "2024-03-02",
      summary: "After refresh",
      toVersionId: "v2",
      filePath: "after.md",
    });
    let activityCalls = 0;
    let refreshCalls = 0;
    server.use(
      mockApi(zeroMemoryActivityContract.get, ({ respond }) => {
        activityCalls++;
        return respond(200, {
          entries: [activityCalls === 1 ? beforeEntry : afterEntry],
          nextCursor: null,
        });
      }),
      mockApi(zeroMemoryDevRefreshContract.refresh, ({ respond }) => {
        refreshCalls++;
        return respond(200, { summarized: 1 });
      }),
    );

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: {
        [FeatureSwitchKey.MemoryViewer]: true,
        [FeatureSwitchKey.MemoryDevRefresh]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Before refresh")).toBeInTheDocument();
    });

    const refreshButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Dev refresh");
    });
    expect(refreshButton).toBeDefined();
    click(refreshButton!);

    await waitFor(() => {
      expect(screen.getByText("After refresh")).toBeInTheDocument();
    });
    expect(screen.queryByText("Before refresh")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Refreshed 1 memory summary").length,
    ).toBeGreaterThan(0);
    expect(refreshCalls).toBe(1);
    expect(activityCalls).toBe(2);
  });

  it("falls back to a deterministic summary line when the LLM summary is null", async () => {
    setMockMemoryActivity({
      entries: [
        {
          date: "2024-03-02",
          summary: null,
          fromVersionId: "v1",
          toVersionId: "v2",
          items: [
            {
              filePath: "a.md",
              diff: addedDiff("a"),
            },
            {
              filePath: "b.md",
              diff: addedDiff("b"),
            },
            {
              filePath: "c.md",
              diff: updatedDiff("old", "new"),
            },
          ],
        },
      ],
      nextCursor: null,
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("3 memory files changed (+3 -1)."),
      ).toBeInTheDocument();
    });
  });

  it("shows a friendly empty state on the Updates tab when there is no activity", async () => {
    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No updates yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Memory-change tracking starts/i),
    ).toBeInTheDocument();
  });

  it("lists memory files and shows selected file content read-only", async () => {
    setupMemoryPage();
    await clickTab("Memory files");

    // Defaults to MEMORY.md (rendered as markdown).
    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Things I know.",
      );
    });

    expect(screen.getAllByText("MEMORY.md").length).toBeGreaterThan(0);
    expect(screen.getAllByText("scratch.txt").length).toBeGreaterThan(0);

    const scratchButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("scratch.txt");
    });
    expect(scratchButton).toBeDefined();
    click(scratchButton!);

    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Plain scratch note.",
      );
    });

    // Read-only: no edit/save affordances.
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent === "Save";
      }),
    ).toBeFalsy();
  });

  it("pins MEMORY.md to the top of the file list", async () => {
    setupMemoryPage();
    await clickTab("Memory files");

    await waitFor(() => {
      expect(screen.getAllByText("MEMORY.md").length).toBeGreaterThan(0);
    });

    const filePaths = ["context.md", "MEMORY.md", "scratch.txt"];
    const fileButtons = queryAllByRoleFast("button").filter((button) => {
      const text = button.textContent ?? "";
      return filePaths.some((path) => {
        return text.includes(path);
      });
    });

    // MEMORY.md is pinned first even though "context.md" sorts before it.
    expect(fileButtons[0]?.textContent).toContain("MEMORY.md");
    expect(fileButtons[1]?.textContent).toContain("context.md");
    expect(fileButtons[2]?.textContent).toContain("scratch.txt");
  });

  it("constrains markdown content so wide code blocks do not displace the file list", async () => {
    setMockMemory({
      exists: true,
      name: "memory",
      size: 900,
      fileCount: 1,
      updatedAt: "2024-01-01T00:00:00Z",
      files: [{ path: "MEMORY.md", size: 900 }],
      fileContents: [
        {
          path: "MEMORY.md",
          content: [
            "# Memory Index",
            "",
            "```sh",
            `npx -p @vm0/cli zero agent edit $ZERO_AGENT_ID --instructions-file /tmp/${"very-long-segment-".repeat(8)}current-instructions.md`,
            "```",
          ].join("\n"),
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await clickTab("Memory files");

    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "zero agent edit",
      );
    });

    const content = screen.getByLabelText("Memory content");
    const markdownRoot = document.querySelector(".wmde-markdown");
    if (!(markdownRoot instanceof HTMLElement)) {
      throw new Error("Missing markdown root");
    }

    expect(content.className).toContain("min-w-0");
    expect(content.parentElement?.className).toContain("min-w-0");
    expect(markdownRoot.className).toContain("min-w-0");
  });

  it("switches files when a relative link to another memory file is clicked", async () => {
    setMockMemory({
      exists: true,
      name: "memory",
      size: 90,
      fileCount: 2,
      updatedAt: "2024-01-01T00:00:00Z",
      files: [
        { path: "MEMORY.md", size: 60 },
        { path: "other-note.md", size: 30 },
      ],
      fileContents: [
        {
          path: "MEMORY.md",
          content: "# Memory Index\n\n- [Other note](other-note.md) — details",
        },
        {
          path: "other-note.md",
          content: "# Other Note\n\nDeep content here.",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await clickTab("Memory files");

    // Defaults to MEMORY.md, which renders the relative link to other-note.md.
    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Other note",
      );
    });

    const internalLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent?.includes("Other note");
    });
    expect(internalLink).toBeDefined();
    click(internalLink!);

    // Clicking switches the viewer instead of navigating away to a 404.
    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Deep content here.",
      );
    });
  });

  it("renders leading YAML frontmatter as memory metadata", async () => {
    setMockMemory({
      exists: true,
      name: "memory",
      size: 180,
      fileCount: 1,
      updatedAt: "2024-01-01T00:00:00Z",
      files: [{ path: "feedback_gh_api_flag.md", size: 180 }],
      fileContents: [
        {
          path: "feedback_gh_api_flag.md",
          content: [
            "---",
            "name: gh api -R Flag Not Supported",
            "description: gh api does not support the -R flag; use full path format instead",
            "type: feedback",
            "---",
            "",
            "Wrong:",
            "",
            "```sh",
            "gh api -R vm0-ai/vm0 repos/vm0-ai/vm0/commits/abc123",
            "```",
            "",
            "Correct:",
            "",
            "```sh",
            "gh api /repos/vm0-ai/vm0/commits/abc123",
            "```",
          ].join("\n"),
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await clickTab("Memory files");

    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Wrong:",
      );
    });

    const content = screen.getByLabelText("Memory content");
    expect(content).toHaveTextContent("gh api -R Flag Not Supported");
    expect(content).toHaveTextContent(
      "gh api does not support the -R flag; use full path format instead",
    );
    expect(content).toHaveTextContent("type");
    expect(content).toHaveTextContent("feedback");
    expect(content).toHaveTextContent("Correct:");
    expect(content).not.toHaveTextContent("---");
    expect(content).not.toHaveTextContent("name:");
    expect(content).not.toHaveTextContent("description:");
    expect(content).not.toHaveTextContent("type: feedback");
  });

  it("leaves external links untouched so the browser handles them", async () => {
    setMockMemory({
      exists: true,
      name: "memory",
      size: 90,
      fileCount: 2,
      updatedAt: "2024-01-01T00:00:00Z",
      files: [
        { path: "MEMORY.md", size: 60 },
        { path: "other-note.md", size: 30 },
      ],
      fileContents: [
        {
          path: "MEMORY.md",
          content:
            "# Memory Index\n\n- [Docs](https://example.com/docs) — external",
        },
        {
          path: "other-note.md",
          content: "# Other Note\n\nDeep content here.",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await clickTab("Memory files");

    // Defaults to MEMORY.md, which renders an absolute external link.
    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent("Docs");
    });

    const externalLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent?.includes("Docs");
    });
    expect(externalLink).toBeDefined();
    // The link keeps its absolute href so the browser (not the viewer) owns it.
    expect(externalLink!.getAttribute("href")).toBe("https://example.com/docs");
    click(externalLink!);

    // External links are not memory files, so the handler must not intercept
    // them: the viewer stays on MEMORY.md rather than switching to a sibling.
    expect(screen.getByLabelText("Memory content")).toHaveTextContent("Docs");
    expect(screen.getByLabelText("Memory content")).not.toHaveTextContent(
      "Deep content here.",
    );
  });
});
