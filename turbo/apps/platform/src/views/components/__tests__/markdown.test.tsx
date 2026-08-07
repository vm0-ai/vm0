import { render, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { StoreProvider } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { Markdown } from "../markdown.tsx";

const context = testContext();

function mockThread(content: string): void {
  context.mocks.api(
    chatThreadEventsContract.list,
    ({ params, query, respond }) => {
      if (
        query.sinceSeqId !== undefined ||
        query.beforeSeqId !== undefined ||
        query.sinceId !== undefined ||
        query.beforeId !== undefined
      ) {
        return respond(200, { events: [] });
      }

      return respond(200, {
        events: [
          {
            id: `msg-${params.threadId}`,
            threadId: params.threadId,
            eventType: "output.message" as const,
            content,
            seqId: 1,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
    },
  );
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
}

type BlobDownloadMock = ReturnType<typeof context.mocks.browser.blobDownload>;

/** The SVG a rendered diagram shows, read back out of its object URL. */
function renderedDiagramMarkup(
  diagram: HTMLElement,
  objectUrls: BlobDownloadMock,
): Promise<string> {
  const url = diagram.getAttribute("src");
  const blob = url ? objectUrls.blobForUrl(url) : null;
  if (!blob) {
    throw new Error("Expected the diagram source to resolve to a Blob");
  }
  return blob.text();
}

function getButtonByText(container: ParentNode, text: string): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((el) => {
    return el.textContent?.trim() === text;
  });

  if (!button) {
    throw new Error(`Could not find button: ${text}`);
  }

  return button;
}

function getLinkByText(container: ParentNode, text: string): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((el) => {
    return el.textContent?.trim() === text;
  });

  if (!link) {
    throw new Error(`Could not find link: ${text}`);
  }

  return link;
}

async function openSettingsDialog(): Promise<HTMLElement> {
  click(await screen.findByText("Test User"));
  click(await screen.findByText("Settings"));
  return waitFor(() => {
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Theme")).toBeInTheDocument();
    return dialog;
  });
}

describe("assistant markdown", () => {
  it("escapes html-like source when requested", () => {
    const { container } = render(
      <StoreProvider value={context.store}>
        <Markdown source="<span> 123 </span>" escapeHtml />
      </StoreProvider>,
    );

    expect(screen.getByText("<span> 123 </span>")).toBeInTheDocument();
    expect(container.querySelector(".wmde-markdown span")).toBeNull();
  });

  it("keeps blockquotes rendering when html is escaped", () => {
    const { container } = render(
      <StoreProvider value={context.store}>
        <Markdown
          source={"Feedback on this part of your reply:\n\n> quoted passage"}
          escapeHtml
        />
      </StoreProvider>,
    );

    const blockquote = container.querySelector(".wmde-markdown blockquote");
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent).toContain("quoted passage");
    // The leading `>` must be consumed as the blockquote marker, not shown as
    // literal text alongside the passage.
    expect(blockquote?.textContent).not.toContain(">");
  });

  it("renders formatted text and follows theme changes", async () => {
    mockThread("**bold text**");

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      expect(
        screen.getByText("bold text", { selector: "strong, b" }),
      ).toBeInTheDocument();
    });

    const settingsDialog = await openSettingsDialog();

    click(getButtonByText(settingsDialog, "Dark"));

    await waitFor(() => {
      expect(
        document.querySelector('[data-color-mode="dark"]'),
      ).toBeInTheDocument();
    });

    click(getButtonByText(settingsDialog, "Light"));

    await waitFor(() => {
      expect(
        document.querySelector('[data-color-mode="light"]'),
      ).toBeInTheDocument();
    });
  });

  it("shows a raw style block as text instead of styling the page", async () => {
    mockThread("<style>\n.zero-injected { color: red }\n</style>");

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      expect(document.querySelector(".wmde-markdown")?.textContent).toContain(
        ".zero-injected { color: red }",
      );
    });
    // A mounted stylesheet would restyle the whole page, not just this message.
    const injectedSheets = Array.from(
      document.querySelectorAll("style"),
    ).filter((sheet) => {
      return sheet.textContent?.includes(".zero-injected") ?? false;
    });
    expect(injectedSheets).toHaveLength(0);
  });

  it("keeps allowlisted html blocks rendering as elements", async () => {
    mockThread("<div><strong>kept markup</strong></div>");

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    const kept = await screen.findByText("kept markup", { selector: "strong" });
    expect(kept).toBeInTheDocument();
  });

  it("renders media links inline", async () => {
    const imageSrc = "https://example.com/cat.png";
    const videoSrc = "https://example.com/clip.mp4";
    mockThread(`[cat](${imageSrc})\n\n[clip](${videoSrc})`);

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      const img = document.querySelector(`img[src="${imageSrc}"]`);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("alt", "cat");
    });
    await waitFor(() => {
      const video = document.querySelector(`video[src="${videoSrc}"]`);
      expect(video).toBeInTheDocument();
      expect(video).toHaveAttribute("controls");
    });
  });

  it("renders mermaid code blocks as diagrams", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    // The diagram is shown by an <img>, so the SVG itself never reaches the
    // document — its markup lives in a browser-native file.
    const diagram = await screen.findByAltText("Diagram");
    const url = diagram.getAttribute("src") ?? "";
    expect(url).toContain("blob:mock-download-");
    const blob = objectUrls.blobForUrl(url);
    expect(blob).toBeInstanceOf(File);
    if (!(blob instanceof File)) {
      throw new Error("Expected the rendered diagram to be a File");
    }
    expect(blob.name).toBe("diagram.svg");
    expect(blob.type).toBe("image/svg+xml");
    await expect(renderedDiagramMarkup(diagram, objectUrls)).resolves.toContain(
      'data-testid="mermaid-svg"',
    );
    expect(document.querySelector("code.language-mermaid")).toBeNull();
    // The source stays reachable next to the diagram.
    expect(screen.getByText("Diagram source")).toBeInTheDocument();
  });

  it("shows every copy of a diagram that appears more than once", async () => {
    context.mocks.browser.blobDownload();
    const fence = "```mermaid\nflowchart TD\n  A --> B\n```";
    mockThread(`${fence}\n\nand again\n\n${fence}`);

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    // Copies share one result entry. Mounting the second must not reset that
    // entry to `rendering`, which would blank the first one.
    const diagrams = await waitFor(() => {
      const found = screen.getAllByAltText("Diagram");
      expect(found).toHaveLength(2);
      return found;
    });
    const [first, second] = diagrams;
    if (!first || !second) {
      throw new Error("Expected both diagrams to be rendered");
    }
    expect(first).toHaveAttribute("src", second.getAttribute("src"));
  });

  it("uses redux themes for light and dark diagrams", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    const settingsDialog = await openSettingsDialog();

    click(getButtonByText(settingsDialog, "Light"));

    const lightDiagram = await screen.findByAltText("Diagram");
    await expect(
      renderedDiagramMarkup(lightDiagram, objectUrls),
    ).resolves.toContain('data-mermaid-theme="redux"');
    const lightUrl = lightDiagram.getAttribute("src") ?? "";

    click(getButtonByText(settingsDialog, "Dark"));

    await waitFor(() => {
      expect(screen.getByAltText("Diagram")).not.toHaveAttribute(
        "src",
        lightUrl,
      );
    });
    await expect(
      renderedDiagramMarkup(screen.getByAltText("Diagram"), objectUrls),
    ).resolves.toContain('data-mermaid-theme="redux-dark"');
    // Theme changes replace the rendered entry, but the panel still owns both
    // object URLs until its lifetime signal aborts.
    expect(objectUrls.revokedUrls).not.toContain(lightUrl);
  });

  it("moves a rendered mermaid diagram from the lightbox into split view", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    const inlineDiagram = await screen.findByAltText("Diagram");
    const inlineUrl = inlineDiagram.getAttribute("src") ?? "";
    const expand = screen.getByLabelText("Expand diagram");
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });

    click(expand);

    const lightboxImage = await screen.findByTestId(
      "attachment-lightbox-image",
    );
    const lightboxUrl = lightboxImage.getAttribute("src") ?? "";
    expect(lightboxUrl).toContain("blob:mock-download-");
    expect(lightboxUrl).toBe(inlineUrl);
    const lightbox = screen.getByTestId("attachment-lightbox");
    expect(
      within(lightbox).getByLabelText("Open in split view"),
    ).toBeInTheDocument();
    expect(within(lightbox).queryByLabelText("Share")).toBeNull();

    click(within(lightbox).getByLabelText("Open in split view"));

    const sidebar = await screen.findByTestId("artifact-sidebar");
    const sidebarImage = within(sidebar).getByTestId(
      "artifact-sidebar-body-image",
    );
    const sidebarUrl = sidebarImage.getAttribute("src") ?? "";
    expect(sidebarImage).toHaveAttribute("alt", "diagram.svg");
    expect(sidebarUrl).toContain("blob:mock-download-");
    expect(sidebarUrl).toBe(inlineUrl);
    expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
    expect(objectUrls.revokedUrls).not.toContain(inlineUrl);

    click(within(sidebar).getByTestId("artifact-sidebar-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    expect(objectUrls.revokedUrls).not.toContain(sidebarUrl);
  });

  it("opens a mermaid diagram directly in an existing artifact sidebar", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarInlineOpen]: true,
      },
    });

    const artifactsButton = await waitFor(() => {
      const found = queryAllByRoleFast("button").find((element) => {
        return element.getAttribute("aria-label") === "Open artifacts";
      });
      if (!found) {
        throw new Error("Expected the artifacts header button");
      }
      return found;
    });
    click(artifactsButton);
    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
    });

    const expand = await screen.findByLabelText("Expand diagram");
    const inlineUrl = screen.getByAltText("Diagram").getAttribute("src") ?? "";
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });
    click(expand);

    // The open sidebar swaps content in place instead of stacking a lightbox.
    const sidebar = await screen.findByTestId("artifact-sidebar");
    const sidebarImage = within(sidebar).getByTestId(
      "artifact-sidebar-body-image",
    );
    const sidebarUrl = sidebarImage.getAttribute("src") ?? "";
    expect(sidebarImage).toHaveAttribute("alt", "diagram.svg");
    expect(sidebarUrl).toContain("blob:mock-download-");
    expect(sidebarUrl).toBe(inlineUrl);
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();

    click(within(sidebar).getByTestId("artifact-sidebar-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    expect(objectUrls.revokedUrls).not.toContain(sidebarUrl);
  });

  it("revokes a mermaid object URL when its chat panel signal aborts", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    const replacementThreadId = "c0000000-0000-4000-a000-000000000002";
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [
          {
            id: replacementThreadId,
            agentId: "c0000000-0000-4000-a000-000000000001",
            title: "Replacement thread",
            sortAt: "2026-01-01T00:00:01Z",
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    const diagram = await screen.findByAltText("Diagram");
    const url = diagram.getAttribute("src") ?? "";
    expect(objectUrls.revokedUrls).not.toContain(url);

    // Following a real thread link replaces the panel through the same route
    // transition a user triggers from the chat sidebar.
    click(
      await waitFor(() => {
        return getLinkByText(document, "Replacement thread");
      }),
    );

    await waitFor(() => {
      expect(document.title).toBe("Replacement thread | VM0");
      expect(objectUrls.revokedUrls).toContain(url);
    });

    const replacementDiagram = await screen.findByAltText("Diagram");
    const replacementUrl = replacementDiagram.getAttribute("src") ?? "";
    expect(replacementUrl).not.toBe(url);
    expect(objectUrls.revokedUrls).not.toContain(replacementUrl);
  });

  it("leaves a streaming mermaid fence as code until it closes", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    await waitFor(() => {
      expect(
        document.querySelector("code.language-mermaid"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("renders a closed mermaid fence that ends the message", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    const diagram = await screen.findByAltText("Diagram");
    await expect(renderedDiagramMarkup(diagram, objectUrls)).resolves.toContain(
      'data-testid="mermaid-svg"',
    );
  });

  it("keeps the source visible when a mermaid diagram cannot be parsed", async () => {
    mockThread("```mermaid\nthis is not a diagram\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mermaid-diagram-fallback"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("mermaid-diagram-fallback").textContent).toBe(
      "this is not a diagram",
    );
    expect(screen.queryByAltText("Diagram")).toBeNull();
    // The box stays mounted across the transition to the fallback: it carries
    // the ref that drives the render, and re-attaching it would abort the
    // render that produced this result and start the same one again.
    expect(screen.getByLabelText("Expand diagram")).toBeInTheDocument();
  });

  it("keeps external links safe", async () => {
    mockThread("[example](https://example.com)");

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      const link = queryAllByRoleFast("link").find((el) => {
        return /example/.test(el.textContent ?? "");
      });
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  // CJK sentences put punctuation directly against the closing delimiter with
  // no space, which plain CommonMark refuses to close.
  it("emphasizes text wrapped in delimiters that touch cjk punctuation", async () => {
    mockThread(
      [
        "**加粗（x）**后面",
        "",
        "*斜体（x）*后面",
        "",
        "***粗斜（x）***后面",
        "",
        "他说**「重要」**的事",
      ].join("\n"),
    );

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.CjkFriendlyMarkdown]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("加粗（x）", { selector: "strong, b" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("斜体（x）", { selector: "em, i" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("粗斜（x）", { selector: "em strong, strong em" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("「重要」", { selector: "strong, b" }),
    ).toBeInTheDocument();
  });

  // Guards the `pluginsFilter` reorder: the strikethrough companion only wins
  // over `remark-gfm`'s own `~~` extension when it runs after it.
  it("strikes through text that touches cjk punctuation", async () => {
    mockThread("~~删除线（test）~~后面");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.CjkFriendlyMarkdown]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("删除线（test）", { selector: "del, s" }),
      ).toBeInTheDocument();
    });
  });

  it("falls back to stock commonmark when the cjk switch is off", async () => {
    mockThread("**加粗（x）**后面\n\n~~删除线（test）~~后面");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.CjkFriendlyMarkdown]: false },
    });

    await waitFor(() => {
      expect(document.querySelector(".wmde-markdown")?.textContent).toContain(
        "**加粗（x）**后面",
      );
    });
    expect(document.querySelector(".wmde-markdown")?.textContent).toContain(
      "~~删除线（test）~~后面",
    );
    expect(document.querySelector(".wmde-markdown del")).toBeNull();
  });

  it("keeps ascii markdown rendering unchanged", async () => {
    mockThread(
      [
        "**bold**, *em*, ~~del~~",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "- [x] done",
      ].join("\n"),
    );

    // The switch must be on explicitly: this asserts ascii output is unchanged
    // *by the cjk plugins*, so it would stop guarding anything if it ran on the
    // stock CommonMark path.
    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.CjkFriendlyMarkdown]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("bold", { selector: "strong, b" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("em", { selector: "em, i" })).toBeInTheDocument();
    expect(screen.getByText("del", { selector: "del, s" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
