import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { describe, expect, it, vi } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroConnectorOpenIdStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { toast } from "@vm0/ui/components/ui/sonner";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import type { ZeroClientFactory } from "../../../signals/api-client.ts";
import { syncArtifactFileToGoogleDrive } from "../../../signals/chat-page/artifact-google-drive-sync.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { artifactPanelWidth$ } from "../../../signals/zero-page/zero-artifact-sidebar.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000040";
const THREAD_PATH = `/chats/${THREAD_ID}`;

function setupChatThread({
  artifactFiles,
  attachFiles,
  content,
  path = THREAD_PATH,
}: {
  artifactFiles?: ChatThreadArtifactFile[];
  attachFiles?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    url: string;
  }[];
  content: string;
  path?: string;
}): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  const messages: PagedChatMessage[] = [
    {
      id: "msg-artifact-user",
      role: "user",
      content: "Show me the artifact",
      runId: "run-artifact",
      seqId: 1,
      createdAt: "2026-03-10T00:00:00Z",
      ...(attachFiles ? { attachFiles } : {}),
    },
    {
      id: "msg-artifact-assistant",
      role: "assistant",
      content,
      runId: "run-artifact",
      seqId: 2,
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-artifact-completed",
      role: "assistant",
      content: null,
      runId: "run-artifact",
      runLifecycleEvent: "completed",
      seqId: 3,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "Artifact thread",
          sortAt: "2026-03-10T00:00:02Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:02Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: "00000000-0000-4000-8000-000000000001",
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceSeqId || query.beforeSeqId) {
      return respond(200, { messages: [] });
    }
    return respond(200, { messages, hasHistoryBefore: false });
  });
  if (artifactFiles) {
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [{ runId: "run-artifact", files: artifactFiles }],
      });
    });
  }

  detachedSetupPage({ context, path });
}

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-release-notes",
    filename: "release-notes.md",
    contentType: "text/markdown",
    size: 42,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

function googleDriveConnector(): ConnectorResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "google-drive",
    authMethod: "oauth",
    externalId: "google-drive-external-id",
    externalUsername: "drive-user",
    externalEmail: "drive-user@example.com",
    oauthScopes: ["drive.file"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function presentationHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <title>Quarterly roadmap</title>
    <script id="vm0-deck-metadata" type="application/json">
      {
        "kind": "presentation-html",
        "editProtocolVersion": 1,
        "slides": {
          "slide-intro": { "speakerNotes": "Open with launch metrics." },
          "slide-plan": { "speakerNotes": "Explain the hiring plan." }
        }
      }
    </script>
  </head>
  <body>
    <section data-vm0-slide data-slide-id="slide-intro">
      <h1 data-vm0-editable="text" data-vm0-edit-id="title">Quarterly roadmap</h1>
      <p data-vm0-editable="text" data-vm0-edit-id="summary">Launch metrics are ahead of plan.</p>
    </section>
    <section data-vm0-slide data-slide-id="slide-plan">
      <h2 data-vm0-editable="text" data-vm0-edit-id="plan">Expansion plan</h2>
      <p data-vm0-editable="text" data-vm0-edit-id="detail">Hire support and scale onboarding.</p>
    </section>
  </body>
</html>`;
}

function captureDownloads(signal: AbortSignal): string[] {
  const downloads: string[] = [];
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof HTMLAnchorElement && event.target.download) {
      event.preventDefault();
      downloads.push(event.target.download);
    }
  };
  document.addEventListener("click", onClick, true);
  signal.addEventListener(
    "abort",
    () => {
      document.removeEventListener("click", onClick, true);
    },
    { once: true },
  );
  return downloads;
}

function getArtifactTab(container: HTMLElement, label: string): HTMLElement {
  const tab = queryAllByRoleFast("tab", container).find((element) => {
    return element.textContent?.trim() === label;
  });
  if (!tab) {
    throw new Error(`${label} artifact tab not found`);
  }
  return tab;
}

async function openArtifactFromInbox(filename: string): Promise<void> {
  click(await screen.findByLabelText(`Open artifact ${filename}`));
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
  });
}

async function backToArtifactInbox(): Promise<void> {
  click(screen.getByLabelText("Back to all artifacts"));
  await waitFor(() => {
    expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
  });
}

function expectFullscreenSafeAreaClass(
  element: HTMLElement,
  layerClassName = "z-[100]",
): void {
  const className = element.getAttribute("class") ?? "";
  expect(className).toContain(layerClassName);
  expect(className).toContain("pt-[var(--sat)]");
  expect(className).toContain("pb-[var(--sab)]");
}

function menuItemByText(text: string): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    const labels = menuItems.map((element) => {
      return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    });
    throw new Error(
      `${text} menu item not found. Available: ${labels.join(", ")}`,
    );
  }
  return item;
}

function mockElementBox(
  element: HTMLElement,
  { height, width }: { height: number; width: number },
) {
  Object.defineProperties(element, {
    clientHeight: {
      configurable: true,
      value: height,
    },
    clientWidth: {
      configurable: true,
      value: width,
    },
    offsetHeight: {
      configurable: true,
      value: height,
    },
    offsetWidth: {
      configurable: true,
      value: width,
    },
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return {
        bottom: height,
        height,
        left: 0,
        right: width,
        toJSON: () => {
          return {};
        },
        top: 0,
        width,
        x: 0,
        y: 0,
      };
    },
  });
}

describe("zero artifact sidebar", () => {
  it("opens document previews from chat, moves them into split view, and closes the pane", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({ content: `[Release notes](${markdownUrl})` });

    const preview = await waitFor(() => {
      return screen.getByTestId("attachment-preview-markdown");
    });

    await user.click(preview);
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open in split view"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Close artifact"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });

  it("resizes the artifact preview pane and persists the width", async () => {
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({
      artifactFiles: [artifactFile(markdownUrl)],
      content: `[Release notes](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
    });

    const resizeHandle = screen.getByRole("separator", {
      name: "Resize preview panel",
    });
    const splitContainer = resizeHandle.parentElement;
    if (!splitContainer) {
      throw new Error("Artifact split container not found");
    }

    splitContainer.getBoundingClientRect = () => {
      return {
        bottom: 800,
        height: 800,
        left: 0,
        right: 1400,
        top: 0,
        width: 1400,
        x: 0,
        y: 0,
        toJSON: () => {
          return {};
        },
      };
    };

    expect(
      splitContainer.style.getPropertyValue("--artifact-panel-width"),
    ).toBe("min(760px, 48vw)");

    fireEvent.pointerDown(resizeHandle, { clientX: 760 });
    fireEvent.pointerMove(window, { clientX: 700 });

    await waitFor(() => {
      expect(
        splitContainer.style.getPropertyValue("--artifact-panel-width"),
      ).toBe("clamp(400px, 700px, calc(100% - 600px))");
      expect(context.store.get(artifactPanelWidth$)).toBe(700);
    });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(document.body.style.cursor).toBe("");
      expect(document.body.style.userSelect).toBe("");
    });
  });

  it("keeps image sidebar zoom controls bounded and resettable", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl =
      "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/photo.png";
    setupChatThread({
      content: `[photo](${imageUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(imageUrl)}`,
    });

    const zoomLevel = await waitFor(() => {
      return screen.getByTestId("artifact-sidebar-image-zoom-level");
    });
    const zoomIn = screen.getByTestId("artifact-sidebar-image-zoom-in");
    const zoomOut = screen.getByTestId("artifact-sidebar-image-zoom-out");

    expect(zoomLevel).toHaveTextContent("100%");
    expect(screen.queryByLabelText("Edit image")).not.toBeInTheDocument();
    await user.click(zoomIn);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(zoomOut);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });

    await user.click(zoomIn);
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("115%");
    });

    await user.click(screen.getByTestId("artifact-sidebar-image-reset-zoom"));
    await waitFor(() => {
      expect(zoomLevel).toHaveTextContent("100%");
    });

    await user.click(screen.getByLabelText("Enter fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expectFullscreenSafeAreaClass(screen.getByTestId("artifact-sidebar"));

    await user.click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
  });

  it("marks app chrome while the artifact sidebar is fullscreen", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl =
      "https://cdn.vm7.io/artifacts/test/fullscreen-layer/photo.png";
    setupChatThread({
      content: `[photo](${imageUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(imageUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });

    const app = document.querySelector(".zero-app");
    if (!(app instanceof HTMLElement)) {
      throw new Error("Zero app shell not found");
    }

    expect(app).not.toHaveAttribute("data-zero-artifact-fullscreen");

    await user.click(screen.getByLabelText("Enter fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
      expect(app).toHaveAttribute("data-zero-artifact-fullscreen", "true");
    });
    expectFullscreenSafeAreaClass(screen.getByTestId("artifact-sidebar"));

    await user.click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
      expect(app).not.toHaveAttribute("data-zero-artifact-fullscreen");
    });
  });

  it("navigates sidebar image artifacts within the current run", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-image-navigation/first.png";
    const notesUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-image-navigation/notes.md";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-image-navigation/second.png";
    // A generated image artifact in the same run that was NOT attached to the
    // message. It must be excluded from message-scoped navigation.
    const generatedArtifactUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-image-navigation/generated.png";
    setupChatThread({
      artifactFiles: [
        artifactFile(firstImageUrl, {
          id: "artifact-sidebar-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
        }),
        artifactFile(notesUrl, {
          id: "artifact-sidebar-notes",
          filename: "notes.md",
          contentType: "text/markdown",
          size: 64,
        }),
        artifactFile(secondImageUrl, {
          id: "artifact-sidebar-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
        }),
        artifactFile(generatedArtifactUrl, {
          id: "artifact-sidebar-generated-image",
          filename: "generated.png",
          contentType: "image/png",
          size: 512,
        }),
      ],
      attachFiles: [
        {
          id: "artifact-sidebar-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
          url: firstImageUrl,
        },
        {
          id: "artifact-sidebar-notes",
          filename: "notes.md",
          contentType: "text/markdown",
          size: 64,
          url: notesUrl,
        },
        {
          id: "artifact-sidebar-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
          url: secondImageUrl,
        },
      ],
      content: "Image artifacts are ready.",
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(firstImageUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
    expect(screen.queryByLabelText("Previous image artifact")).toBeNull();
    expect(screen.getByLabelText("Next image artifact")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "alt",
      "first.png",
    );

    await user.click(screen.getByLabelText("Next image artifact"));
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    expect(
      screen.getByLabelText("Previous image artifact"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Next image artifact")).toBeNull();

    // While an editable control is focused (e.g. the chat composer), arrow keys
    // keep moving the caret instead of navigating images in the non-fullscreen
    // sidebar.
    const editable = document.createElement("input");
    document.body.appendChild(editable);
    editable.focus();
    fireEvent.keyDown(editable, { key: "ArrowLeft" });
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "alt",
      "second.png",
    );

    // With focus released, arrow keys navigate again.
    editable.remove();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });
  });

  it("fits tall image artifacts inside the preview when opened", async () => {
    const posterUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-fit-tall-image/poster.png";
    setupChatThread({
      artifactFiles: [
        artifactFile(posterUrl, {
          id: "artifact-sidebar-tall-image",
          filename: "poster.png",
          contentType: "image/png",
          size: 2048,
        }),
      ],
      content: "Image artifact is ready.",
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(posterUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "poster.png",
      );
    });

    const zoomStage = screen.getByTestId("zoomable-image-canvas");
    const image = screen.getByTestId("artifact-sidebar-body-image");
    mockElementBox(zoomStage, { height: 600, width: 800 });
    Object.defineProperties(image, {
      naturalHeight: {
        configurable: true,
        value: 3200,
      },
      naturalWidth: {
        configurable: true,
        value: 1600,
      },
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(image).toHaveStyle({ width: "300px" });
      expect(
        screen.getByTestId("artifact-sidebar-image-zoom-level"),
      ).toHaveTextContent("100%");
    });
  });

  it("keeps the sidebar fullscreen state while navigating images", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-fullscreen-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-fullscreen-navigation/second.png";
    setupChatThread({
      artifactFiles: [
        artifactFile(firstImageUrl, {
          id: "artifact-sidebar-fs-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
        }),
        artifactFile(secondImageUrl, {
          id: "artifact-sidebar-fs-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
        }),
      ],
      attachFiles: [
        {
          id: "artifact-sidebar-fs-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
          url: firstImageUrl,
        },
        {
          id: "artifact-sidebar-fs-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
          url: secondImageUrl,
        },
      ],
      content: "Image artifacts are ready.",
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(firstImageUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });

    await user.click(screen.getByLabelText("Enter fullscreen"));
    expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();

    // In fullscreen the sidebar is immersive: arrow keys navigate even when a
    // control is focused, and fullscreen is preserved.
    const shareButton = screen.getByLabelText("Share artifact");
    shareButton.focus();
    fireEvent.keyDown(shareButton, { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    // Navigating between images must not collapse fullscreen.
    expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Enter fullscreen")).toBeNull();
  });

  it("lets the lightbox modal own arrow keys while the sidebar stays put", async () => {
    const user = userEvent.setup({ delay: null });
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-modal-coexist/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/sidebar-modal-coexist/second.png";
    setupChatThread({
      artifactFiles: [
        artifactFile(firstImageUrl, {
          id: "artifact-coexist-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
        }),
        artifactFile(secondImageUrl, {
          id: "artifact-coexist-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
        }),
      ],
      attachFiles: [
        {
          id: "artifact-coexist-first-image",
          filename: "first.png",
          contentType: "image/png",
          size: 128,
          url: firstImageUrl,
        },
        {
          id: "artifact-coexist-second-image",
          filename: "second.png",
          contentType: "image/png",
          size: 256,
          url: secondImageUrl,
        },
      ],
      content: "Image artifacts are ready.",
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(firstImageUrl)}`,
    });

    // The sidebar shows the first image.
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });

    // Open the lightbox modal (on the first image) from the chat attachment.
    await user.click(screen.getByLabelText("Preview first.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "first.png",
      );
    });

    // Arrow keys drive the modal; the underlying sidebar must not also advance.
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "second.png",
      );
    });
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "alt",
      "first.png",
    );
  });

  it("hides the sidebar for unsupported artifact deep links", async () => {
    setupChatThread({
      content: "Artifacts are ready.",
      path: `${THREAD_PATH}?artifact=image%3Agenerated-1&artifact-fullscreen=1`,
    });

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });

  it("shares an artifact and exposes download destinations from the sidebar", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    const downloads = captureDownloads(context.signal);
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.connectors([]);
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({
      artifactFiles: [artifactFile(markdownUrl)],
      content: `[Release notes](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Share artifact"));
    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));

    await waitFor(() => {
      expect(screen.getByText("Download")).toBeInTheDocument();
      expect(screen.getByText("Connect Google Drive")).toBeInTheDocument();
    });
    const googleDriveItem = menuItemByText("Connect Google Drive");
    expect(googleDriveItem).not.toHaveClass("text-muted-foreground");

    await user.hover(googleDriveItem);
    await waitFor(() => {
      expect(
        screen.getAllByText("Connect Google Drive to upload artifacts").length,
      ).toBeGreaterThan(0);
    });

    click(menuItemByText("Download"));

    await waitFor(() => {
      expect(downloads).toContain("release-notes.md");
    });
  });

  it("starts Google Drive connection from server catalog auth metadata", async () => {
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/server-authored.md";
    const authMethod = "partner-openid";
    const authorizationUrl =
      "https://openid.example.test/google-drive/authorize";
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    context.mocks.data.connectors([]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          {
            connectorRef: "google-drive",
            label: "Google Drive",
            description: "Google Drive artifact storage",
            icon: {
              url: "https://icons.example.test/google-drive.svg",
              invertInDarkMode: false,
            },
            category: "productivity",
            generation: [],
            tags: [],
            authMethods: [
              {
                id: authMethod,
                label: "Partner OpenID",
                description: null,
                grantKind: "openid-auth",
                manualFields: [],
                startOptions: [],
              },
            ],
            permissionSummary: {
              hasPermissions: false,
              permissionCount: 0,
              hasCategories: false,
              hasDefaultPolicyOverrides: false,
            },
            connection: null,
            connected: false,
            connectionStatus: "not-connected",
            scopeMismatch: false,
            authMethodSupportsRefresh: false,
            tokenExpiresAt: null,
            singleAuthCodeAuthMethodId: null,
            connectNotice: null,
          },
        ],
      });
    });
    context.mocks.api(
      zeroConnectorOpenIdStartContract.start,
      ({ body, params, respond }) => {
        expect(params.type).toBe("google-drive");
        expect(body).toStrictEqual({
          authMethod,
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, { authorizationUrl });
      },
    );
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Server-authored connector", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({
      artifactFiles: [artifactFile(markdownUrl)],
      content: `[Server-authored connector](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Connect Google Drive")).toBeEnabled();
    });
    click(menuItemByText("Connect Google Drive"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(authorizationUrl);
    });
  });

  it("shows download progress while downloading an HTML artifact", async () => {
    const user = userEvent.setup({ delay: null });
    const siteUrl = "https://launch.sites.vm7.io/launch-plan.html";
    const downloads = captureDownloads(context.signal);
    const downloadReady = context.mocks.deferred<Response>();
    context.mocks.data.connectors([]);
    context.mocks.http.get(siteUrl, () => {
      return downloadReady.promise;
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(siteUrl, {
          id: "artifact-launch-plan",
          filename: "launch-plan.html",
          contentType: "text/html",
          artifactKind: "hosted-site",
          size: 1024,
        }),
      ],
      content: `[Launch plan](${siteUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(siteUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Download artifact")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Download")).toBeInTheDocument();
    });
    click(menuItemByText("Download"));

    const downloadButton = screen.getByLabelText("Download artifact");
    await waitFor(() => {
      expect(downloadButton).toHaveAttribute("aria-busy", "true");
      expect(downloadButton).toBeDisabled();
      expect(downloadButton.querySelector(".animate-spin")).not.toBeNull();
    });

    downloadReady.resolve(
      new Response("<!doctype html><html><body>Launch plan</body></html>", {
        headers: { "Content-Type": "text/html" },
      }),
    );

    await waitFor(() => {
      expect(downloads).toContain("launch-plan.html");
      expect(downloadButton).not.toHaveAttribute("aria-busy");
      expect(downloadButton).not.toBeDisabled();
      expect(downloadButton.querySelector(".animate-spin")).toBeNull();
    });
  });

  it("uploads an artifact to connected Google Drive from the sidebar", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/drive-release-notes.md";
    const artifactFiles = [
      artifactFile(markdownUrl, {
        id: "artifact-drive-release-notes",
        filename: "drive-release-notes.md",
      }),
    ];
    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ respond }) => {
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-release-notes",
            name: "drive-release-notes.md",
            webViewLink: "https://drive.test/drive-release-notes",
          },
        };
        return respond(200, {
          id: "drive-file-release-notes",
          name: "drive-release-notes.md",
          webViewLink: "https://drive.test/drive-release-notes",
        });
      },
    );
    setupChatThread({
      artifactFiles,
      content: `[Release notes](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Upload to Google Drive")).toBeInTheDocument();
    });
    click(menuItemByText("Upload to Google Drive"));

    await waitFor(() => {
      expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
    });

    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Synced to Google Drive"),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Synced to Google Drive")).toBeInTheDocument();
    });
  });

  it("shows connect action when Google Drive is connected but disabled for the agent", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/drive-agent-notes.md";
    const artifactFiles = [
      artifactFile(markdownUrl, {
        id: "artifact-drive-agent-notes",
        filename: "drive-agent-notes.md",
        googleDriveSync: { status: "disconnected" },
      }),
    ];
    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, { connectors: [] });
    });
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Agent notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    let enabledTypes: string[] = [];
    let agentAuthorized = false;
    let artifactSynced = false;
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes });
    });
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        expect(body).toStrictEqual({
          enabledTypes: ["google-drive"],
          operation: "add",
        });
        enabledTypes = [...body.enabledTypes];
        agentAuthorized = true;
        return respond(200, { enabledTypes });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ body, respond }) => {
        expect(enabledTypes).toStrictEqual(["google-drive"]);
        expect(body).toStrictEqual({
          runId: "run-artifact",
          fileId: "artifact-drive-agent-notes",
        });
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-agent-notes",
            name: "drive-agent-notes.md",
            webViewLink: "https://drive.test/drive-agent-notes",
          },
        };
        artifactSynced = true;
        return respond(200, {
          id: "drive-file-agent-notes",
          name: "drive-agent-notes.md",
          webViewLink: "https://drive.test/drive-agent-notes",
        });
      },
    );
    setupChatThread({
      artifactFiles,
      content: `[Agent notes](${markdownUrl})`,
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(markdownUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByText("The artifact is ready.")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Connect Google Drive")).toBeEnabled();
    });
    await user.click(menuItemByText("Connect Google Drive"));

    await waitFor(() => {
      expect(agentAuthorized).toBeTruthy();
    });
    await waitFor(() => {
      expect(artifactSynced).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Synced to Google Drive")).toBeInTheDocument();
    });
  });

  it("does not finish a Google Drive upload after the page signal is aborted", async () => {
    const resetUploadSignal$ = resetSignal();
    const uploadSignal = context.store.set(resetUploadSignal$, context.signal);
    const dismissToast = vi.spyOn(toast, "dismiss");
    const createClient = (() => {
      return {
        syncGoogleDrive: () => {
          context.store.set(resetUploadSignal$, context.signal);
          return Promise.resolve({
            status: 200 as const,
            body: {
              id: "drive-file-release-notes",
              name: "drive-release-notes.md",
              webViewLink: null,
            },
          });
        },
      };
    }) as ZeroClientFactory;

    try {
      await expect(
        syncArtifactFileToGoogleDrive({
          createClient,
          threadId: THREAD_ID,
          runId: "run-artifact",
          fileId: "artifact-drive-release-notes",
          filename: "drive-release-notes.md",
          signal: uploadSignal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(dismissToast).toHaveBeenCalledTimes(1);
    } finally {
      dismissToast.mockRestore();
    }
  });

  it("renders inline previews from assistant artifact links without breaking markdown tables or code blocks", async () => {
    const imageUrl = "https://cdn.vm7.io/artifacts/test/run-2/chart.png";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/run-2/demo.mp4";
    const markdownUrl = "https://cdn.vm7.io/artifacts/test/run-2/notes.md";
    const textUrl = "https://cdn.vm7.io/artifacts/test/run-2/memo.txt";
    const jsonUrl = "https://cdn.vm7.io/artifacts/test/run-2/status.json";
    const htmlUrl = "https://cdn.vm7.io/artifacts/test/run-2/site.html";
    const hostedSiteUrl = "https://customer-launch-a1b2c3d4.sites.vm7.io";
    const fencedHostedSiteUrl = "https://deck-summary-d09dae7b.sites.vm7.io";
    const openFencedHostedSiteUrl =
      "https://page-content-pack-d09dae7b.sites.vm7.io";
    const fileUrl = "/artifacts/test/run-2/archive.bin";

    setupChatThread({
      content: `Artifacts are ready.

| Item | Link |
| ---- | ---- |
| Table keeps URLs as text | ${imageUrl} |

\`\`\`
${videoUrl}
\`\`\`

\`\`\`text
${fencedHostedSiteUrl}
\`\`\`

${imageUrl}
${videoUrl}
[Release notes](${markdownUrl})
[Operations memo](${textUrl})
${jsonUrl}
[Launch site](${htmlUrl})
${hostedSiteUrl}
Download the archive here: ${fileUrl}.

\`\`\`text
${openFencedHostedSiteUrl}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Table keeps URLs as text")).toBeInTheDocument();
      expect(screen.getByText(videoUrl)).toBeInTheDocument();
      expect(screen.getByAltText("chart.png")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(screen.getByTestId("attachment-preview-markdown")).toHaveAttribute(
        "aria-label",
        "Open markdown preview for notes.md",
      );
      expect(screen.getByTestId("attachment-preview-text")).toHaveAttribute(
        "aria-label",
        "Open text preview for memo.txt",
      );
      expect(screen.getByTestId("attachment-preview-json")).toHaveAttribute(
        "aria-label",
        "Open json preview for status.json",
      );
      const htmlPreview = screen
        .getAllByTestId("attachment-preview-html")
        .find((element) => {
          return (
            element.getAttribute("aria-label") ===
            "Open html preview for Launch site"
          );
        });
      expect(htmlPreview).toHaveAttribute(
        "aria-label",
        "Open html preview for Launch site",
      );
      expect(screen.getByText("Customer Launch")).toBeInTheDocument();
      expect(screen.getByText("Deck Summary")).toBeInTheDocument();
      expect(screen.getByText("Page Content Pack")).toBeInTheDocument();
      const customerLaunchFrame = document.querySelector(
        'iframe[title="Site preview for Customer Launch"]',
      );
      expect(customerLaunchFrame).toBeInTheDocument();
      expect(customerLaunchFrame).toHaveAttribute(
        "sandbox",
        "allow-same-origin allow-scripts",
      );
      expect(
        document.querySelector('iframe[title="Site preview for Deck Summary"]'),
      ).toBeInTheDocument();
      expect(
        document.querySelector(
          'iframe[title="Site preview for Page Content Pack"]',
        ),
      ).toBeInTheDocument();
      expect(screen.getByTestId("attachment-preview-file")).toHaveAttribute(
        "aria-label",
        "Download archive.bin",
      );
    });
  });

  it("refreshes artifact metadata while another artifact preview is open", async () => {
    const user = userEvent.setup({ delay: null });
    const existingUrl =
      "https://cdn.vm7.io/artifacts/test/realtime-preview/existing-notes.md";
    const presentationUrl =
      "https://cdn.vm7.io/artifacts/test/realtime-preview/later-presentation.html";
    const existingArtifact = artifactFile(existingUrl, {
      id: "artifact-existing-notes",
      filename: "existing-notes.md",
    });
    const laterPresentation = artifactFile(presentationUrl, {
      id: "artifact-later-presentation",
      filename: "later-presentation.html",
      contentType: "text/html",
      artifactKind: "presentation-html",
    });
    let artifactRuns = [
      { runId: "run-existing-artifact", files: [existingArtifact] },
    ];
    context.mocks.http.get(existingUrl, () => {
      return new Response("# Existing notes\n\nThe first artifact is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(presentationUrl, () => {
      return new Response(presentationHtml(), {
        headers: { "Content-Type": "text/html" },
      });
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: artifactRuns });
    });
    setupChatThread({
      content: `[Existing notes](${existingUrl})

[Later presentation](${presentationUrl})`,
    });

    click(await screen.findByLabelText("Open artifacts"));
    await waitFor(() => {
      expect(screen.getByText("existing-notes.md")).toBeInTheDocument();
    });

    const topic = `chatThreadArtifactsChanged:${THREAD_ID}`;
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    await openArtifactFromInbox("existing-notes.md");
    await waitFor(() => {
      expect(
        screen.getByText("The first artifact is ready."),
      ).toBeInTheDocument();
    });

    artifactRuns = [
      ...artifactRuns,
      { runId: "run-later-artifact", files: [laterPresentation] },
    ];
    context.mocks.ably.trigger(topic);

    await user.click(
      screen.getByLabelText("Open html preview for Later presentation"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Edit presentation"),
    ).not.toBeInTheDocument();
  });

  it("browses artifact inbox sections, searches, and opens a result", async () => {
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    const imageUrl =
      "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/chart.png";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-demo.mp4";
    const audioUrl = "https://cdn.vm7.io/artifacts/test/run-1/voice-note.mp3";
    const htmlUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-site.html";
    const videoPreviewImageUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/launch-demo-poster.jpg";
    const htmlPreviewImageUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/launch-site-preview.webp";
    const pdfUrl = "https://cdn.vm7.io/artifacts/test/run-1/rollout-plan.pdf";
    const csvUrl = "https://cdn.vm7.io/artifacts/test/run-1/metrics.csv";
    const logUrl = "https://cdn.vm7.io/artifacts/test/run-1/debug.log";
    context.mocks.http.get(markdownUrl, () => {
      return new Response(
        "# Release notes\n\nOpened from the artifact inbox.",
        {
          headers: { "Content-Type": "text/plain" },
        },
      );
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(markdownUrl),
        artifactFile(imageUrl, {
          id: "artifact-chart",
          filename: "launch-chart.png",
          contentType: "image/png",
          size: 128,
        }),
        artifactFile(videoUrl, {
          id: "artifact-video",
          filename: "launch-demo.mp4",
          contentType: "video/mp4",
          size: 2_048_000,
          previewImageUrl: videoPreviewImageUrl,
        }),
        artifactFile(audioUrl, {
          id: "artifact-audio",
          filename: "voice-note.mp3",
          contentType: "audio/mpeg",
          size: 512_000,
        }),
        artifactFile(htmlUrl, {
          id: "artifact-site",
          filename: "launch-site.html",
          contentType: "text/html",
          size: 4096,
          previewImageUrl: htmlPreviewImageUrl,
        }),
        artifactFile(pdfUrl, {
          id: "artifact-pdf",
          filename: "rollout-plan.pdf",
          contentType: "application/pdf",
          size: 8192,
        }),
        artifactFile(csvUrl, {
          id: "artifact-csv",
          filename: "metrics.csv",
          contentType: "text/csv",
          size: 2048,
        }),
        artifactFile(logUrl, {
          id: "artifact-log",
          filename: "debug.log",
          contentType: "application/octet-stream",
          size: 1024,
        }),
      ],
      content: "Artifacts are ready.",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Open artifacts")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open artifacts"));

    let inbox = await waitFor(() => {
      const element = screen.getByTestId("artifact-inbox");
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
      expect(screen.getByText("launch-chart.png")).toBeInTheDocument();
      expect(screen.getByText("launch-demo.mp4")).toBeInTheDocument();
      expect(screen.getByText("voice-note.mp3")).toBeInTheDocument();
      expect(screen.getByText("launch-site.html")).toBeInTheDocument();
      expect(screen.getByText("rollout-plan.pdf")).toBeInTheDocument();
      expect(screen.getByText("metrics.csv")).toBeInTheDocument();
      expect(screen.getByText("debug.log")).toBeInTheDocument();
      return element;
    });
    expect(screen.getByText("Video")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
    expect(screen.getByText("Hosted site")).toBeInTheDocument();
    expect(screen.getAllByText("PDF").length).toBeGreaterThan(0);
    expect(screen.getByText("Data")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(
      screen.getByTestId("artifact-video-preview-badge"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("artifact-html-preview-badge"),
    ).toBeInTheDocument();
    const videoThumbnail = screen.getByTestId("artifact-video-thumbnail-badge");
    const htmlThumbnail = screen.getByTestId("artifact-html-thumbnail-badge");
    expect(videoThumbnail).toHaveAttribute("src", videoPreviewImageUrl);
    expect(htmlThumbnail).toHaveAttribute("src", htmlPreviewImageUrl);
    expect(
      screen.queryByTestId("artifact-video-preview-fallback"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("launch-site.html artifact thumbnail"),
    ).not.toBeInTheDocument();

    fireEvent.error(videoThumbnail);
    fireEvent.error(htmlThumbnail);

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-video-preview-fallback"),
      ).toBeInTheDocument();
      expect(
        screen.getByTitle("launch-site.html artifact thumbnail"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("artifact-inbox-fullscreen-toggle"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expectFullscreenSafeAreaClass(screen.getByTestId("artifact-inbox"));

    click(screen.getByTestId("artifact-inbox-fullscreen-toggle"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    inbox = screen.getByTestId("artifact-inbox");

    click(getArtifactTab(inbox, "Media"));

    await waitFor(() => {
      expect(screen.getByText("launch-chart.png")).toBeInTheDocument();
      expect(screen.getByText("launch-demo.mp4")).toBeInTheDocument();
      expect(screen.getByText("voice-note.mp3")).toBeInTheDocument();
      expect(screen.queryByText("release-notes.md")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-site.html")).not.toBeInTheDocument();
    });

    click(getArtifactTab(inbox, "Sites"));

    await waitFor(() => {
      expect(screen.getByText("launch-site.html")).toBeInTheDocument();
      expect(screen.queryByText("launch-chart.png")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Search artifacts"));
    await fill(screen.getByPlaceholderText("Search"), "release");

    await waitFor(() => {
      expect(
        screen.getByText("No artifacts match this view."),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "" },
    });
    click(getArtifactTab(inbox, "Docs"));

    await waitFor(() => {
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
      expect(screen.getByText("rollout-plan.pdf")).toBeInTheDocument();
      expect(screen.getByText("metrics.csv")).toBeInTheDocument();
      expect(screen.getByText("debug.log")).toBeInTheDocument();
      expect(screen.queryByText("launch-chart.png")).not.toBeInTheDocument();
      expect(screen.queryByText("launch-site.html")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open artifact release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByText("Opened from the artifact inbox."),
      ).toBeInTheDocument();
    });

    await backToArtifactInbox();
    expect(screen.getByText("release-notes.md")).toBeInTheDocument();

    click(screen.getByLabelText("Close artifacts"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });

  it("opens data and document artifact previews from the inbox", async () => {
    const csvUrl = "https://cdn.vm7.io/artifacts/test/run-1/metrics.csv";
    const jsonUrl = "https://cdn.vm7.io/artifacts/test/run-1/status.json";
    const logUrl = "https://cdn.vm7.io/artifacts/test/run-1/debug.log";
    const pdfUrl = "https://cdn.vm7.io/artifacts/test/run-1/rollout-plan.pdf";
    const archiveUrl = "https://cdn.vm7.io/artifacts/test/run-1/archive.bin";
    context.mocks.http.get(csvUrl, () => {
      return new Response("name,value\nlaunch,42\n", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(jsonUrl, () => {
      return new Response('{"status":"ready","count":2}', {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.http.get(logUrl, () => {
      return new Response("build complete", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(csvUrl, {
          id: "artifact-data-csv",
          filename: "metrics.csv",
          contentType: "text/csv",
        }),
        artifactFile(jsonUrl, {
          id: "artifact-data-json",
          filename: "status.json",
          contentType: "application/json",
        }),
        artifactFile(logUrl, {
          id: "artifact-data-log",
          filename: "debug.log",
          contentType: "application/octet-stream",
        }),
        artifactFile(pdfUrl, {
          id: "artifact-document-pdf",
          filename: "rollout-plan.pdf",
          contentType: "application/pdf",
        }),
        artifactFile(archiveUrl, {
          id: "artifact-document-archive",
          filename: "archive.bin",
          contentType: "application/octet-stream",
        }),
      ],
      content: "Document artifacts are ready.",
    });

    click(await screen.findByLabelText("Open artifacts"));
    const inbox = await screen.findByTestId("artifact-inbox");
    click(getArtifactTab(inbox, "Docs"));

    await openArtifactFromInbox("metrics.csv");
    await waitFor(() => {
      expect(screen.getByText("launch")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("status.json");
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-json"),
      ).toHaveTextContent('"status": "ready"');
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("debug.log");
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-text"),
      ).toHaveTextContent("build complete");
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("rollout-plan.pdf");
    const pdfFrame = screen.getByTestId("artifact-sidebar-body-pdf");
    const pdfFrameWrapper = pdfFrame.parentElement;
    if (!pdfFrameWrapper) {
      throw new Error("PDF frame wrapper not found");
    }
    expect(screen.getByTestId("artifact-sidebar-stage")).toHaveClass(
      "overflow-hidden",
    );
    expect(pdfFrame).toHaveAttribute("title", "rollout-plan.pdf preview");
    expect(pdfFrame).toHaveClass("h-full", "min-h-0", "border-0");
    expect(pdfFrameWrapper).toHaveClass("h-full", "min-h-0");
    await backToArtifactInbox();

    click(getArtifactTab(screen.getByTestId("artifact-inbox"), "All"));
    await openArtifactFromInbox("archive.bin");
    expect(
      screen.getByText("No inline preview available for this file."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("archive.bin").length).toBeGreaterThan(1);
  });

  it("shows empty and unavailable data previews from the inbox", async () => {
    const emptyCsvUrl = "https://cdn.vm7.io/artifacts/test/run-1/empty.csv";
    const failedCsvUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/failed-metrics.csv";
    const failedJsonUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/failed-status.json";
    const failedMarkdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/failed-notes.md";
    const failedTextUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/failed-notes.txt";
    context.mocks.http.get(emptyCsvUrl, () => {
      return new Response("", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(failedCsvUrl, () => {
      return new Response(null, { status: 503 });
    });
    context.mocks.http.get(failedTextUrl, () => {
      return new Response(null, { status: 503 });
    });
    context.mocks.http.get(failedJsonUrl, () => {
      return new Response(null, { status: 503 });
    });
    context.mocks.http.get(failedMarkdownUrl, () => {
      return new Response(null, { status: 503 });
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(emptyCsvUrl, {
          id: "artifact-empty-csv",
          filename: "empty.csv",
          contentType: "text/csv",
        }),
        artifactFile(failedCsvUrl, {
          id: "artifact-failed-csv",
          filename: "failed-metrics.csv",
          contentType: "text/csv",
        }),
        artifactFile(failedJsonUrl, {
          id: "artifact-failed-json",
          filename: "failed-status.json",
          contentType: "application/json",
        }),
        artifactFile(failedMarkdownUrl, {
          id: "artifact-failed-markdown",
          filename: "failed-notes.md",
          contentType: "text/markdown",
        }),
        artifactFile(failedTextUrl, {
          id: "artifact-failed-text",
          filename: "failed-notes.txt",
          contentType: "text/plain",
        }),
      ],
      content: "Data artifacts are ready.",
    });

    click(await screen.findByLabelText("Open artifacts"));
    const inbox = await screen.findByTestId("artifact-inbox");
    click(getArtifactTab(inbox, "Docs"));

    await openArtifactFromInbox("empty.csv");
    await waitFor(() => {
      expect(screen.getByText("Empty CSV.")).toBeInTheDocument();
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("failed-metrics.csv");
    await waitFor(() => {
      expect(screen.getByText("CSV preview unavailable.")).toBeInTheDocument();
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("failed-status.json");
    await waitFor(() => {
      expect(screen.getByText("JSON preview unavailable.")).toBeInTheDocument();
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("failed-notes.md");
    await waitFor(() => {
      expect(
        screen.getByText("Markdown preview unavailable."),
      ).toBeInTheDocument();
    });
    await backToArtifactInbox();

    await openArtifactFromInbox("failed-notes.txt");
    await waitFor(() => {
      expect(screen.getByText("Text preview unavailable.")).toBeInTheDocument();
    });
  });

  it("opens media and hosted site artifact previews from the inbox", async () => {
    const videoUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-demo.mp4";
    const audioUrl = "https://cdn.vm7.io/artifacts/test/run-1/voice-note.mp3";
    const htmlUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-site.html";
    setupChatThread({
      artifactFiles: [
        artifactFile(videoUrl, {
          id: "artifact-media-video",
          filename: "launch-demo.mp4",
          contentType: "video/mp4",
        }),
        artifactFile(audioUrl, {
          id: "artifact-media-audio",
          filename: "voice-note.mp3",
          contentType: "audio/mpeg",
        }),
        artifactFile(htmlUrl, {
          id: "artifact-site-html",
          filename: "launch-site.html",
          contentType: "text/html",
        }),
      ],
      content: "Media artifacts are ready.",
    });

    click(await screen.findByLabelText("Open artifacts"));
    const inbox = await screen.findByTestId("artifact-inbox");
    click(getArtifactTab(inbox, "Media"));

    await openArtifactFromInbox("launch-demo.mp4");
    expect(screen.getByTestId("artifact-sidebar-body-video")).toHaveAttribute(
      "aria-label",
      "Video preview for launch-demo.mp4",
    );
    await backToArtifactInbox();

    await openArtifactFromInbox("voice-note.mp3");
    expect(screen.getByTestId("artifact-sidebar-body-audio")).toHaveAttribute(
      "aria-label",
      "Audio preview for voice-note.mp3",
    );
    await backToArtifactInbox();

    click(getArtifactTab(screen.getByTestId("artifact-inbox"), "Sites"));
    await openArtifactFromInbox("launch-site.html");
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "title",
      "launch-site.html preview",
    );
    expect(
      screen.getByTestId("artifact-sidebar-open-external"),
    ).toBeInTheDocument();
  });
});
