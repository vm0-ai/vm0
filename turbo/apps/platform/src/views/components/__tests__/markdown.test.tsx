import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type ChatMessageFeedbackPayload,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { StoreProvider } from "ccstate-react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { Markdown } from "../markdown.tsx";

const context = testContext();

function mockThread(
  content: string,
  role: "assistant" | "user" = "assistant",
  feedbackPayload?: ChatMessageFeedbackPayload,
): void {
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId) {
      return respond(200, { messages: [] });
    }

    return respond(200, {
      messages: [
        {
          id: "msg-1",
          role,
          content,
          ...(feedbackPayload ? { feedbackPayload } : {}),
          ...(role === "user" ? { runId: "run-markdown" } : {}),
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      computerUseHostId: null,
      codexServiceTier: null,
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

function getButtonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`Could not find button: ${label}`);
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

describe("feedback message cards", () => {
  it("keeps a structured feedback message as a chip after reload", async () => {
    const feedbackPayload = {
      version: 1 as const,
      items: [{ id: 1, quote: "Persisted quote", note: "Persisted note" }],
    };
    mockThread("Keep the opening concise.", "user", feedbackPayload);

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.FeedbackMessageCards]: true },
    });

    const chip = await waitFor(() => {
      return getButtonByLabel("Show 1 quote");
    });
    expect(chip).toBeInTheDocument();
    expect(document.querySelector(".zero-chat-bubble-user")).toHaveTextContent(
      "Keep the opening concise.",
    );

    await userEvent.setup({ delay: null }).click(chip);
    await expect(
      screen.findByText("Persisted quote"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Persisted note")).toBeInTheDocument();
  });

  it("renders one sent-message chip with all feedback details on hover", async () => {
    const user = userEvent.setup({ delay: null });
    const feedbackPayload = {
      version: 1 as const,
      items: [
        { id: 1, quote: "First quoted passage", note: "first note" },
        { id: 2, quote: "Second quoted passage", note: "second note" },
      ],
    };
    mockThread("Follow up on these points.", "user", feedbackPayload);

    detachedSetupPage({
      context,
      path: "/chats/thread-markdown",
      featureSwitches: { [FeatureSwitchKey.FeedbackMessageCards]: true },
    });

    const chip = await waitFor(() => {
      return getButtonByLabel("Show 2 quotes");
    });
    expect(document.querySelectorAll("[data-feedback-chip]")).toHaveLength(1);
    const userBubble = document.querySelector(".zero-chat-bubble-user");
    expect(userBubble).toHaveTextContent("Follow up on these points.");
    expect(userBubble).not.toContainElement(chip);
    expect(screen.queryByText("first note")).not.toBeInTheDocument();

    await user.hover(chip);
    await waitFor(() => {
      expect(screen.getAllByText("first note").length).toBeGreaterThan(0);
      expect(screen.getAllByText("second note").length).toBeGreaterThan(0);
    });
    const hoverDetails = document.querySelector<HTMLElement>(
      '[data-feedback-details="hover"]',
    );
    expect(hoverDetails).toHaveStyle({
      width: "min(22rem, calc(100vw - 1.5rem))",
    });
    const quoteList = document.querySelector("[data-feedback-comment-list]");
    expect(quoteList?.querySelectorAll("[data-feedback-item]")).toHaveLength(2);
    expect(screen.getAllByText("First quoted passage").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Second quoted passage").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Selected text 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Quotes")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryAllByText("first note")).toHaveLength(0);
    });
    await user.click(chip);
    await waitFor(() => {
      expect(screen.getAllByText("first note").length).toBeGreaterThan(0);
    });
    const clickDetails = document.querySelector<HTMLElement>(
      '[data-feedback-details="click"]',
    );
    expect(clickDetails).toHaveStyle({
      width: "min(22rem, calc(100vw - 1.5rem))",
    });
    // The raw intro line is not shown as literal text.
    expect(
      screen.queryByText("Feedback on 2 parts of your reply:"),
    ).not.toBeInTheDocument();
  });
});
