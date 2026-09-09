import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { fillComposer, mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

warmMermaidParser();

async function closeArtifactPreview() {
  const dialog = await screen.findByTestId("attachment-lightbox");
  const closeButton = queryAllByRoleFast("button", dialog).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Close";
  });
  if (!closeButton) {
    throw new Error("Expected the artifact preview close button");
  }
  click(closeButton);
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
}

function getArtifactPreviewFrame(): HTMLIFrameElement {
  const container = screen.getByTestId("artifact-dialog-site-frame");
  const frame = container.querySelector("iframe");
  if (!frame) {
    throw new Error("Expected the artifact dialog to contain a preview frame");
  }
  return frame;
}

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

describe("built-in welcome thread", () => {
  it("stays closed until selected and renders real artifact previews without thread actions", async () => {
    await setupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: true,
      },
    });

    const chatList = await screen.findByTestId("chat-list-column");
    const row = await within(chatList).findByTestId(
      "built-in-welcome-thread-row",
    );
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(screen.queryByTestId("welcome-thread-page")).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId("chat-thread-menu-trigger"),
    ).not.toBeInTheDocument();

    const welcomeLink = queryAllByRoleFast("link", row).find((candidate) => {
      return candidate.textContent === "Welcome to Okou";
    });
    if (!welcomeLink) {
      throw new Error("Welcome thread link not found");
    }
    click(welcomeLink);

    const page = await screen.findByTestId("welcome-thread-page");
    const content = within(page).getByTestId("welcome-thread-content");
    expect(pathname()).toBe("/chats/welcome");
    await waitFor(() => {
      expect(document.title).toBe("Welcome to Okou | Okou");
    });
    expect(
      within(page).getByRole("heading", { name: "Hi, I'm Okou" }),
    ).toBeInTheDocument();
    const campaignVisual = within(content).getByRole("img", {
      name: "Campaign visual delivered by Okou",
    });
    expect(campaignVisual).toBeInTheDocument();
    expect(campaignVisual.getAttribute("src")).toContain(
      "/ref-bookshop-interior.jpg",
    );
    const presentationPreview = within(content).getByTestId(
      "attachment-preview-html",
    );
    expect(presentationPreview).toHaveAttribute(
      "title",
      "Presentation delivered by Okou",
    );
    const videoPreview = queryAllByRoleFast("button", content).find(
      (candidate) => {
        return (
          candidate.getAttribute("aria-label") ===
          "Preview product-launch-film.mp4"
        );
      },
    );
    if (!videoPreview) {
      throw new Error("Expected the video artifact preview action");
    }
    expect(videoPreview).toBeInTheDocument();
    expect(
      within(content).queryByTestId("welcome-video-preview"),
    ).not.toBeInTheDocument();
    expect(
      within(content).getByText("Qualify inbound leads"),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("heading", {
        name: "How to work with me as a team",
      }),
    ).toBeInTheDocument();
    expect(
      within(content).getByRole("heading", { name: "Talk to me in Slack" }),
    ).toBeInTheDocument();
    expect(within(content).getByText("/okou")).toBeInTheDocument();
    const slackSetupLink = queryAllByRoleFast("link", content).find(
      (candidate) => {
        return candidate.textContent === "Set up Slack";
      },
    );
    expect(slackSetupLink).toHaveAttribute(
      "href",
      `${window.location.origin}/works`,
    );
    expect(
      within(page).getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(buttonNamed("Expand diagram", content)).toBeEnabled();
    });
    expect(
      within(content).getByTestId("welcome-team-diagram"),
    ).toBeInTheDocument();
    expect(
      within(content).getByTestId("welcome-slack-diagram"),
    ).toBeInTheDocument();
    expect(within(content).getByText("A workflow")).toBeInTheDocument();
    expect(
      within(content).getByText("Okou replies in the thread"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(content.querySelector("a[href^='okou://']")).toBeNull();
    });

    const imagePreview = campaignVisual.closest("button");
    if (!imagePreview) {
      throw new Error("Expected the campaign artifact preview action");
    }
    click(imagePreview);
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute(
      "src",
      expect.stringContaining("/ref-bookshop-interior.jpg"),
    );
    await closeArtifactPreview();

    click(presentationPreview);
    await screen.findByTestId("artifact-dialog-site-frame");
    await waitFor(() => {
      expect(getArtifactPreviewFrame()).toHaveAttribute(
        "src",
        expect.stringContaining("/playful-launch-presentation.html"),
      );
    });
    await closeArtifactPreview();

    click(videoPreview);
    await expect(
      screen.findByLabelText("Video preview for product-launch-film.mp4"),
    ).resolves.toBeVisible();
    await closeArtifactPreview();
  });

  it("uses the authoritative switch when a direct route has a stale disabled cache", async () => {
    await setupPage({
      context,
      path: "/chats/welcome",
      cachedFeatureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: false,
      },
      featureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: true,
      },
    });

    await expect(
      screen.findByTestId("welcome-thread-page"),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe("/chats/welcome");
  });

  it("starts a normal persisted chat from the welcome composer", async () => {
    const message = "Plan a customer launch campaign";
    let createdThreadId: string | undefined;
    let sentThreadId: string | undefined;
    mockChatLifecycle(context, {
      onThreadCreate: ({ clientThreadId }) => {
        createdThreadId = clientThreadId;
      },
      onSendRequest: ({ threadId }) => {
        sentThreadId = threadId;
      },
    });
    await setupPage({
      context,
      path: "/chats/welcome",
      featureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: true,
      },
    });

    const composer = await screen.findByRole("textbox", { name: "Message" });
    await fillComposer(composer, message);
    await waitFor(() => {
      expect(buttonNamed("Send")).toBeEnabled();
    });
    click(buttonNamed("Send"));

    await waitFor(() => {
      expect(createdThreadId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
      expect(sentThreadId).toBe(createdThreadId);
      expect(pathname()).toBe(`/chats/${createdThreadId}`);
      expect(screen.getByText(message)).toBeInTheDocument();
    });
  });

  it("hides the entry and redirects the built-in route while the feature is disabled", async () => {
    await setupPage({
      context,
      path: "/chats/welcome",
      cachedFeatureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: true,
      },
      featureSwitches: {
        [FeatureSwitchKey.OnboardingChat]: false,
      },
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
    expect(
      screen.queryByTestId("built-in-welcome-thread-row"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("welcome-thread-page")).not.toBeInTheDocument();
  });
});
