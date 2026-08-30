import { act, render, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { StoreProvider } from "ccstate-react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { Markdown as RichMarkdown } from "../rich-markdown.tsx";
import { mockChatEventRows } from "../../okou-page/__tests__/chat-event-test-helpers.ts";

const context = testContext();
warmMermaidParser();
const THREAD_ID = "eb000000-0000-4000-a000-000000000001";

function threadSnapshot(id: string, title: string) {
  return {
    id,
    agentId: "c0000000-0000-4000-a000-000000000001",
    title,
    sortAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
  };
}

function mockThread(
  content: string,
  additionalThreads: ReturnType<typeof threadSnapshot>[] = [],
): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        threadSnapshot(THREAD_ID, "Markdown thread"),
        ...additionalThreads,
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      if (query.sinceSeqId >= 1) {
        return respond(200, chatEventRowsResponse([], query));
      }

      return respond(
        200,
        chatEventRowsResponse(
          mockChatEventRows([
            {
              id: `msg-${params.threadId}`,
              threadId: params.threadId,
              eventType: "output.message" as const,
              content,
              seqId: 1,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]),
          query,
        ),
      );
    },
  );
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
}

function mockAgentsPage(): void {
  context.mocks.api(logsListContract.list, ({ respond }) => {
    return respond(200, {
      data: [],
      pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      filters: { statuses: [], sources: [], agents: [] },
    });
  });
}

type BlobDownloadMock = ReturnType<typeof context.mocks.browser.blobDownload>;

/** The SVG a rendered diagram shows, read back through its blob URL. */
function renderedDiagramMarkup(
  diagram: HTMLElement,
  objectUrls: BlobDownloadMock,
): Promise<string> {
  const url = diagram.getAttribute("src") ?? "";
  const blob = objectUrls.blobForUrl(url);
  if (!blob) {
    throw new Error("Expected the diagram to be shown from a blob URL");
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

function getCopyButton(code: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".copied"),
  ).find((element) => {
    return element.dataset.code === code;
  });
  if (!button) {
    throw new Error(`Could not find copy button: ${code}`);
  }
  return button;
}

async function navigateToAgents(): Promise<void> {
  click(
    await waitFor(() => {
      return getLinkByText(document, "Agents");
    }),
  );
  await screen.findByRole("heading", { name: "Agents" });
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
        <RichMarkdown source="<span> 123 </span>" escapeHtml />
      </StoreProvider>,
    );

    expect(screen.getByText("<span> 123 </span>")).toBeInTheDocument();
    expect(container.querySelector(".wmde-markdown span")).toBeNull();
  });

  it("keeps blockquotes rendering when html is escaped", () => {
    const { container } = render(
      <StoreProvider value={context.store}>
        <RichMarkdown
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

  it("renders syntax-free assistant text without a rich loading state", async () => {
    mockThread("Plain response with punctuation: ready (now).");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await expect(
      screen.findByText("Plain response with punctuation: ready (now)."),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("rich-content-loading")).toBeNull();
  });

  it("renders code fences without syntax token decoration", async () => {
    mockThread("```ts\nconst value = 1;\n```");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const code = await screen.findByText("const value = 1;", {
      selector: "code",
    });
    expect(code).toBeInTheDocument();
    expect(code.querySelector(".token")).toBeNull();
  });

  it("keeps math source visible as plain text", async () => {
    const source = "$$a^2 + b^2 = c^2$$";
    mockThread(source);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await expect(screen.findByText(source)).resolves.toBeInTheDocument();
    expect(document.querySelector(".katex")).toBeNull();
  });

  it("renders formatted text and follows theme changes", async () => {
    mockThread("**bold text**");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

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

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

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

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const kept = await screen.findByText("kept markup", { selector: "strong" });
    expect(kept).toBeInTheDocument();
  });

  it("renders media links inline", async () => {
    const imageSrc = "https://example.com/cat.png";
    const videoSrc = "https://example.com/clip.mp4";
    mockThread(`[cat](${imageSrc})\n\n[clip](${videoSrc})`);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

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

  it("keeps copy confirmations local to each mounted button", async () => {
    const firstCode = "const first = 1;\n";
    const secondCode = "const second = 2;\n";
    const clipboard = context.mocks.browser.clipboardWriteText();
    mockThread(
      [
        "```ts",
        firstCode.trimEnd(),
        "```",
        "",
        "```ts",
        secondCode.trimEnd(),
        "```",
      ].join("\n"),
    );
    mockAgentsPage();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const first = await waitFor(() => {
      return getCopyButton(firstCode);
    });
    const second = getCopyButton(secondCode);
    click(first);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copy to clipboard");
    });
    click(second);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copied");
    });
    expect(clipboard.writes).toStrictEqual([firstCode, secondCode]);

    await navigateToAgents();
    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      expect(getCopyButton(firstCode)).toHaveAccessibleName(
        "Copy to clipboard",
      );
      expect(getCopyButton(secondCode)).toHaveAccessibleName(
        "Copy to clipboard",
      );
    });
  });

  it("leaves an opening-only mermaid fence as code", async () => {
    mockThread("```mermaid");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        document.querySelector("code.language-mermaid"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("renders mermaid code blocks as diagrams", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const renderingButton = await waitFor(() => {
      const button = screen.getByLabelText("Expand diagram");
      expect(button).toBeDisabled();
      expect(
        button.closest('[data-mermaid-status="rendering"]'),
      ).not.toBeNull();
      return button;
    });
    expect(
      renderingButton.closest('[data-slot="tooltip-trigger"]'),
    ).toHaveClass("icon-tooltip-trigger");

    // The diagram is shown by an <img>, so the SVG itself never reaches the
    // document — its markup travels behind a registry-owned blob URL.
    const diagram = await screen.findByAltText("Diagram");
    await expect(renderedDiagramMarkup(diagram, objectUrls)).resolves.toContain(
      'data-testid="mermaid-svg"',
    );
    const renderedButton = screen.getByLabelText("Expand diagram");
    expect(renderedButton).toBeEnabled();
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
      path: `/chats/${THREAD_ID}`,
    });

    // Copies share one diagram entry keyed by content, so both images resolve
    // to the same rendered markup.
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
      path: `/chats/${THREAD_ID}`,
    });

    const settingsDialog = await openSettingsDialog();

    click(getButtonByText(settingsDialog, "Light"));

    const lightDiagram = await screen.findByAltText("Diagram");
    await waitFor(async () => {
      await expect(
        renderedDiagramMarkup(screen.getByAltText("Diagram"), objectUrls),
      ).resolves.toContain('data-mermaid-theme="redux"');
    });
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
    const darkUrl = screen.getByAltText("Diagram").getAttribute("src") ?? "";

    click(getButtonByText(settingsDialog, "Light"));

    await waitFor(() => {
      expect(screen.getByAltText("Diagram")).toHaveAttribute("src", lightUrl);
    });
    expect(darkUrl).not.toBe(lightUrl);
    // Resolved theme is a finite two-value domain. Returning to light reuses
    // the root-owned URL rather than allocating a blob per theme flip.
    expect(objectUrls.revokedUrls).not.toContain(lightUrl);
    expect(objectUrls.revokedUrls).not.toContain(darkUrl);
  });

  it("moves a rendered mermaid diagram from the lightbox into split view", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
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
    expect(lightboxUrl).not.toBe(inlineUrl);
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
    expect(sidebarUrl).not.toBe(inlineUrl);
    expect(sidebarUrl).not.toBe(lightboxUrl);
    expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
    expect(objectUrls.revokedUrls).not.toContain(inlineUrl);
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(objectUrls.revokedUrls).toContain(lightboxUrl);
    });

    click(within(sidebar).getByTestId("artifact-sidebar-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    expect(objectUrls.revokedUrls).toContain(sidebarUrl);
    expect(objectUrls.revokedUrls).not.toContain(inlineUrl);
  });

  it("opens a mermaid diagram directly in an existing artifact sidebar", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n" +
        "```mermaid\nflowchart TD\n  C --> D\n```",
    );

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
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

    const expandButtons = await screen.findAllByLabelText("Expand diagram");
    const inlineUrls = screen.getAllByAltText("Diagram").map((diagram) => {
      return diagram.getAttribute("src") ?? "";
    });
    await waitFor(() => {
      for (const expand of expandButtons) {
        expect(expand).toBeEnabled();
      }
    });
    const [firstExpand, secondExpand] = expandButtons;
    if (!firstExpand || !secondExpand) {
      throw new Error("Expected both diagram expand buttons");
    }
    click(firstExpand);

    // The open sidebar swaps content in place instead of stacking a lightbox.
    const sidebar = await screen.findByTestId("artifact-sidebar");
    const sidebarImage = within(sidebar).getByTestId(
      "artifact-sidebar-body-image",
    );
    const firstSidebarUrl = sidebarImage.getAttribute("src") ?? "";
    expect(sidebarImage).toHaveAttribute("alt", "diagram.svg");
    expect(firstSidebarUrl).toContain("blob:mock-download-");
    expect(inlineUrls).not.toContain(firstSidebarUrl);
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    expect(within(sidebar).queryByLabelText("Share artifact")).toBeNull();
    expect(objectUrls.revokedUrls).not.toContain(firstSidebarUrl);

    click(secondExpand);
    const secondSidebarUrl = await waitFor(() => {
      const url = within(sidebar)
        .getByTestId("artifact-sidebar-body-image")
        .getAttribute("src");
      expect(url).not.toBe(firstSidebarUrl);
      return url ?? "";
    });
    expect(objectUrls.revokedUrls).toContain(firstSidebarUrl);
    expect(objectUrls.revokedUrls).not.toContain(secondSidebarUrl);

    click(within(sidebar).getByTestId("artifact-sidebar-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
    expect(objectUrls.revokedUrls).toContain(secondSidebarUrl);
    for (const inlineUrl of inlineUrls) {
      expect(objectUrls.revokedUrls).not.toContain(inlineUrl);
    }
  });

  it("releases a mermaid sidebar object URL when leaving chat", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");
    mockAgentsPage();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
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
    await screen.findByTestId("thread-sidebar-artifacts");

    const expand = await screen.findByLabelText("Expand diagram");
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });
    click(expand);

    const sidebarUrl = await waitFor(() => {
      return within(screen.getByTestId("artifact-sidebar"))
        .getByTestId("artifact-sidebar-body-image")
        .getAttribute("src");
    });
    expect(sidebarUrl).toContain("blob:mock-download-");
    expect(objectUrls.revokedUrls).not.toContain(sidebarUrl);

    await navigateToAgents();

    await waitFor(() => {
      expect(objectUrls.revokedUrls).toContain(sidebarUrl);
    });
  });

  it("leaves a streaming mermaid fence as code until it closes", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        document.querySelector("code.language-mermaid"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("keeps raw html mermaid separate from a streaming fence", async () => {
    context.mocks.browser.blobDownload();
    const rawHtml = [
      '<pre><code class="language-mermaid">',
      "flowchart TD",
      "  X --> Y",
      "</code></pre>",
    ].join("\n");
    mockThread(`${rawHtml}\n\n\`\`\`mermaid\nflowchart TD\n  A --> B`);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await screen.findByAltText("Diagram");
    const streamingCode = await waitFor(() => {
      const blocks = document.querySelectorAll("code.language-mermaid");
      expect(blocks).toHaveLength(1);
      return blocks[0];
    });
    expect(streamingCode.textContent?.trim()).toBe("flowchart TD\n  A --> B");
    expect(
      document.querySelector("[data-vm0-markdown-mermaid-fence]"),
    ).toBeNull();
  });

  it("renders a closed mermaid fence that ends the message", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    mockThread("Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const diagram = await screen.findByAltText("Diagram");
    await expect(renderedDiagramMarkup(diagram, objectUrls)).resolves.toContain(
      'data-testid="mermaid-svg"',
    );
  });

  it("keeps an invalid mermaid fence as an ordinary code block", async () => {
    context.mocks.browser.blobDownload();
    mockThread("```mermaid\nthis is not a diagram\n```");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(document.querySelector("code.language-mermaid")).not.toBeNull();
    });
    expect(document.querySelector("code.language-mermaid")?.textContent).toBe(
      "this is not a diagram",
    );
    expect(document.querySelector(".mermaid-block")).toBeNull();
    expect(screen.queryByAltText("Diagram")).toBeNull();
  });

  it("keeps unsupported mermaid diagram types as ordinary code blocks", async () => {
    context.mocks.browser.blobDownload();
    const source = "classDiagram\n  A <|-- B";
    mockThread(`\`\`\`mermaid\n${source}\n\`\`\``);

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(document.querySelector("code.language-mermaid")).not.toBeNull();
    });
    expect(document.querySelector("code.language-mermaid")?.textContent).toBe(
      source,
    );
    expect(document.querySelector(".mermaid-block")).toBeNull();
    expect(screen.queryByAltText("Diagram")).toBeNull();
  });

  it("keeps external links safe", async () => {
    mockThread("[example](https://example.com)");

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      const link = queryAllByRoleFast("link").find((el) => {
        return /example/.test(el.textContent ?? "");
      });
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
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

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
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
