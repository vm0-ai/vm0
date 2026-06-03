import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockMemory } from "../../../mocks/handlers/api-memory.ts";
import { setMockMemoryActivity } from "../../../mocks/handlers/api-memory-activity.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();

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

    await clickTab("Raw files");

    await waitFor(() => {
      expect(screen.getByText("No memory yet")).toBeInTheDocument();
    });
  });

  it("defaults to the Updates tab and renders the daily activity timeline", async () => {
    setMockMemoryActivity({
      entries: [
        {
          date: "2024-03-02",
          summary: "Zero learned how you prefer to deploy.",
          fromVersionId: "v1",
          toVersionId: "v2",
          items: [
            {
              kind: "learned",
              title: "Deploy preference",
              description: "Use blue-green deploys",
              filePath: "deploy.md",
              beforeSnippet: null,
              afterSnippet: "Use blue-green deploys",
            },
            {
              kind: "updated",
              title: "Project setup",
              description: null,
              filePath: "setup.md",
              beforeSnippet: "old setup",
              afterSnippet: "new setup",
            },
          ],
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero learned how you prefer to deploy."),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Deploy preference")).toBeInTheDocument();
    expect(screen.getByText("Learned")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();

    // Evidence is hidden until the item is expanded.
    expect(screen.queryByText("new setup")).not.toBeInTheDocument();

    const updatedItem = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Project setup");
    });
    expect(updatedItem).toBeDefined();
    click(updatedItem!);

    await waitFor(() => {
      expect(screen.getByText("new setup")).toBeInTheDocument();
    });
    expect(screen.getByText("old setup")).toBeInTheDocument();
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
              kind: "learned",
              title: "Fact A",
              description: null,
              filePath: "a.md",
              beforeSnippet: null,
              afterSnippet: "a",
            },
            {
              kind: "learned",
              title: "Fact B",
              description: null,
              filePath: "b.md",
              beforeSnippet: null,
              afterSnippet: "b",
            },
            {
              kind: "updated",
              title: "Fact C",
              description: null,
              filePath: "c.md",
              beforeSnippet: "old",
              afterSnippet: "new",
            },
          ],
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("3 changes — 2 learned, 1 updated"),
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
    await clickTab("Raw files");

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
    await clickTab("Raw files");

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

    await clickTab("Raw files");

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

    await clickTab("Raw files");

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

    await clickTab("Raw files");

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
