import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockThread(content: string): void {
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId) {
      return respond(200, { messages: [] });
    }

    return respond(200, {
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: "thread-markdown",
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
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
