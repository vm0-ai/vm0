import { render, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
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
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
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
          id: "msg-1",
          threadId: "thread-markdown",
          eventType: "output.message" as const,
          content,
          seqId: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
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
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="mermaid-svg"]'),
      ).toBeInTheDocument();
    });
    expect(document.querySelector("code.language-mermaid")).toBeNull();
    // The source stays reachable next to the diagram.
    expect(screen.getByText("Diagram source")).toBeInTheDocument();
  });

  it("uses redux themes for light and dark diagrams", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    const settingsDialog = await openSettingsDialog();

    click(getButtonByText(settingsDialog, "Light"));

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="mermaid-svg"]'),
      ).toHaveAttribute("data-mermaid-theme", "redux");
    });

    click(getButtonByText(settingsDialog, "Dark"));

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="mermaid-svg"]'),
      ).toHaveAttribute("data-mermaid-theme", "redux-dark");
    });
  });

  it("opens a rendered mermaid diagram in the zoomable lightbox", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    const expand = await screen.findByLabelText("Expand diagram");
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });

    click(expand);

    const lightboxImage = await screen.findByTestId(
      "attachment-lightbox-image",
    );
    expect(lightboxImage.getAttribute("src")).toContain("data:image/svg+xml");
  });

  it("keeps a mermaid diagram in the lightbox while the artifact sidebar is open", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: {
        [FeatureSwitchKey.MermaidDiagrams]: true,
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
    await waitFor(() => {
      expect(expand).toBeEnabled();
    });
    click(expand);

    // A rendered diagram is an inline data URL, so it opens the lightbox and
    // leaves the artifact sidebar on its own content.
    const lightboxImage = await screen.findByTestId(
      "attachment-lightbox-image",
    );
    expect(lightboxImage.getAttribute("src")).toContain("data:image/svg+xml");
    expect(screen.getByTestId("thread-sidebar-artifacts")).toBeInTheDocument();
  });

  it("leaves a streaming mermaid fence as code until it closes", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    await waitFor(() => {
      expect(
        document.querySelector("code.language-mermaid"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".mermaid-block")).toBeNull();
  });

  it("renders a closed mermaid fence that ends the message", async () => {
    mockThread("Here is the flow:\n\n```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="mermaid-svg"]'),
      ).toBeInTheDocument();
    });
  });

  it("keeps the source visible when a mermaid diagram cannot be parsed", async () => {
    mockThread("```mermaid\nthis is not a diagram\n```");

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.MermaidDiagrams]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("mermaid-diagram-fallback"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("mermaid-diagram-fallback").textContent).toBe(
      "this is not a diagram",
    );
    expect(document.querySelector('[data-testid="mermaid-svg"]')).toBeNull();
  });

  it("leaves mermaid blocks as code when the feature switch is off", async () => {
    mockThread("```mermaid\nflowchart TD\n  A --> B\n```");

    detachedSetupPage({ context, path: "/chats/thread-markdown" });

    await waitFor(() => {
      expect(
        document.querySelector("code.language-mermaid"),
      ).toBeInTheDocument();
    });
    expect(document.querySelector(".mermaid-block")).toBeNull();
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
});
