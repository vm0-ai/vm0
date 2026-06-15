import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type ChatThreadArtifactFile,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { toast } from "@vm0/ui/components/ui/sonner";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { artifactPanelWidth$ } from "../../../signals/zero-page/zero-artifact-sidebar.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000040";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const CONTENT_TYPES_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PRESENTATION_NS =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const PRESENTATION_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const SLIDE_REL_TYPE = `${OFFICE_RELATIONSHIPS_NS}/slide`;

function setupChatThread({
  artifactFiles,
  content,
  featureSwitches,
  path = THREAD_PATH,
}: {
  artifactFiles?: ChatThreadArtifactFile[];
  content: string;
  featureSwitches?: Parameters<typeof detachedSetupPage>[0]["featureSwitches"];
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
      customSkills: [],
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
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-artifact-assistant",
      role: "assistant",
      content,
      runId: "run-artifact",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-artifact-completed",
      role: "assistant",
      content: null,
      runId: "run-artifact",
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: null,
      agentId: AGENT_ID,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId || query.beforeId) {
      return respond(200, { messages: [] });
    }
    return respond(200, { messages, hasHistoryBefore: false });
  });
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
    });
  });
  if (artifactFiles) {
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [{ runId: "run-artifact", files: artifactFiles }],
      });
    });
  }

  detachedSetupPage({ context, featureSwitches, path });
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

function presentationPptxBlob(): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CONTENT_TYPES_NS}">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="${PRESENTATION_CONTENT_TYPE}"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>
</Types>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:r="${OFFICE_RELATIONSHIPS_NS}">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
  <Relationship Id="rId1" Type="${SLIDE_REL_TYPE}" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="${SLIDE_REL_TYPE}" Target="slides/slide2.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}"/>`,
  );
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS_NS}"/>`,
  );
  return zip.generateAsync({ type: "blob" });
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

function completePresentationPptxExport(
  frame: HTMLIFrameElement,
  blob: Blob,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        blob,
        status: "success",
        type: "vm0-presentation-pptx-export",
      },
      source: frame.contentWindow,
    }),
  );
}

function setupPresentationArtifactThread(
  presentationUrl: string,
  html = presentationHtml(),
): void {
  const filename =
    new URL(presentationUrl).pathname.split("/").pop() ?? "presentation.html";
  context.mocks.http.get(presentationUrl, () => {
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  });
  context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  });
  setupChatThread({
    artifactFiles: [
      artifactFile(presentationUrl, {
        id: "artifact-quarterly-roadmap",
        filename,
        contentType: "text/html",
        artifactKind: "presentation-html",
        size: 1024,
      }),
    ],
    content: `[Quarterly roadmap](${presentationUrl})`,
    featureSwitches: {
      [FeatureSwitchKey.PresentationHtmlPptxDownload]: true,
    },
    path: `${THREAD_PATH}?artifact=${encodeURIComponent(presentationUrl)}`,
  });
}

function assetBackedPresentationHtml(assetUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>Asset backed deck</title>
    <style>
      .slide-bg { background-image: url("${assetUrl}"); }
    </style>
  </head>
  <body>
    <section data-vm0-slide data-slide-id="asset-slide" class="slide-bg" style="border-image: url('${assetUrl}') 30">
      <h1 data-vm0-editable="text" data-vm0-edit-id="title">Asset backed deck</h1>
      <img src="${assetUrl}" alt="Roadmap cover" />
    </section>
  </body>
</html>`;
}

function fallbackEditablePresentationHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <title>Legacy launch plan</title>
    <meta http-equiv="refresh" content="0;url=https://example.com/redirect">
  </head>
  <body onclick="window.evil = true">
    <h1>Legacy launch plan</h1>
    <p>Review the older deck format before launch.</p>
    <div>
      <span>Nested fallback copy</span>
    </div>
    <a href="j a v a s c r i p t:alert(1)">Unsafe action</a>
    <a href="http://[invalid">Broken action</a>
    <a href="https://example.com/safe">Safe action</a>
    <img src="data:text/html,blocked" alt="Blocked inline asset">
    <iframe src="https://example.com/embed"></iframe>
  </body>
</html>`;
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

function mockIntersectionObserver(): { triggerAll: () => void } {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IntersectionObserver",
  );
  const observers: { trigger: () => void }[] = [];

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly scrollMargin: string;
    readonly thresholds: readonly number[];
    private observedTargets: Element[] = [];

    constructor(
      private readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? "0px";
      this.scrollMargin = "0px";
      this.thresholds = Array.isArray(options?.threshold)
        ? options.threshold
        : [options?.threshold ?? 0];
      observers.push(this);
    }

    observe(target: Element): void {
      if (!this.observedTargets.includes(target)) {
        this.observedTargets = [...this.observedTargets, target];
      }
    }

    unobserve(target: Element): void {
      this.observedTargets = this.observedTargets.filter((observed) => {
        return observed !== target;
      });
    }

    disconnect(): void {
      this.observedTargets = [];
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    trigger(): void {
      const entries = this.observedTargets.map((target) => {
        return {
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRatio: 1,
          intersectionRect: target.getBoundingClientRect(),
          isIntersecting: true,
          rootBounds: null,
          target,
          time: performance.now(),
        } as IntersectionObserverEntry;
      });
      if (entries.length > 0) {
        this.callback(entries, this);
      }
    }
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: TestIntersectionObserver,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalDescriptor) {
        Object.defineProperty(
          globalThis,
          "IntersectionObserver",
          originalDescriptor,
        );
        return;
      }
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
    },
    { once: true },
  );

  return {
    triggerAll: () => {
      for (const observer of observers) {
        observer.trigger();
      }
    },
  };
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

    await user.click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
  });

  it("shows an unavailable pane for unsupported artifact deep links", async () => {
    setupChatThread({
      content: "Artifacts are ready.",
      path: `${THREAD_PATH}?artifact=image%3Agenerated-1&artifact-fullscreen=1`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByText("Artifact unavailable")).toBeInTheDocument();
      expect(
        screen.getByText("Unsupported artifact reference."),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifact"));

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

    click(menuItemByText("Download"));

    await waitFor(() => {
      expect(downloads).toContain("release-notes.md");
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

  it("downloads a presentation artifact as PPTX from the sidebar", async () => {
    const presentationUrl = "https://deck.sites.vm7.io/quarterly-roadmap.html";
    const downloads = captureDownloads(context.signal);
    setupPresentationArtifactThread(presentationUrl);

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Download artifact")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Download (.pptx)")).toBeInTheDocument();
    });
    click(menuItemByText("Download (.pptx)"));

    const exportFrame = await waitFor(() => {
      const frame = document.querySelector(
        'iframe[title="Presentation PPTX export"]',
      );
      expect(frame).toBeInstanceOf(HTMLIFrameElement);
      return frame as HTMLIFrameElement;
    });
    completePresentationPptxExport(exportFrame, await presentationPptxBlob());

    await waitFor(() => {
      expect(downloads).toContain("quarterly-roadmap.pptx");
      expect(
        document.querySelector('iframe[title="Presentation PPTX export"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("renders inline previews from assistant artifact links without breaking markdown tables or code blocks", async () => {
    const imageUrl = "https://cdn.vm7.io/artifacts/test/run-2/chart.png";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/run-2/demo.mp4";
    const markdownUrl = "https://cdn.vm7.io/artifacts/test/run-2/notes.md";
    const textUrl = "https://cdn.vm7.io/artifacts/test/run-2/memo.txt";
    const jsonUrl = "https://cdn.vm7.io/artifacts/test/run-2/status.json";
    const htmlUrl = "https://cdn.vm7.io/artifacts/test/run-2/site.html";
    const hostedSiteUrl = "https://customer-launch-a1b2c3d4.sites.vm7.io";
    const fileUrl = "/artifacts/test/run-2/archive.bin";

    setupChatThread({
      content: `Artifacts are ready.

| Item | Link |
| ---- | ---- |
| Table keeps URLs as text | ${imageUrl} |

\`\`\`
${videoUrl}
\`\`\`

${imageUrl}
${videoUrl}
[Release notes](${markdownUrl})
[Operations memo](${textUrl})
${jsonUrl}
[Launch site](${htmlUrl})
${hostedSiteUrl}
Download the archive here: ${fileUrl}.`,
    });

    await waitFor(() => {
      expect(screen.getByText("Table keeps URLs as text")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
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
      expect(
        document.querySelector(
          'iframe[title="Site preview for Customer Launch"]',
        ),
      ).toBeInTheDocument();
      expect(screen.getByTestId("attachment-preview-file")).toHaveAttribute(
        "aria-label",
        "Download archive.bin",
      );
    });
  });

  it("shows a presentation editor error when the source deck cannot be loaded", async () => {
    const presentationUrl = "https://deck.sites.vm7.io/missing-roadmap.html";
    context.mocks.http.get(presentationUrl, () => {
      return new Response(null, { status: 503 });
    });
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(null, { status: 503 });
    });
    setupChatThread({
      artifactFiles: [
        artifactFile(presentationUrl, {
          id: "artifact-missing-roadmap",
          filename: "missing-roadmap.html",
          contentType: "text/html",
          artifactKind: "presentation-html",
          size: 1024,
        }),
      ],
      content: `[Missing roadmap](${presentationUrl})`,
      featureSwitches: {
        [FeatureSwitchKey.PresentationHtmlPptxDownload]: true,
      },
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(presentationUrl)}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Edit presentation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Edit presentation"));

    await waitFor(() => {
      expect(
        screen.getByText("Failed to fetch presentation HTML (503)"),
      ).toBeInTheDocument();
    });
  });

  it("downloads an asset-backed presentation without speaker notes", async () => {
    const presentationUrl = "https://deck.sites.vm7.io/asset-backed-deck.html";
    const assetUrl = "https://assets.test/roadmap-cover.png";
    const downloads = captureDownloads(context.signal);
    context.mocks.http.get(assetUrl, () => {
      return new Response(new Blob(["png"], { type: "image/png" }));
    });
    setupPresentationArtifactThread(
      presentationUrl,
      assetBackedPresentationHtml(assetUrl),
    );

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Download artifact")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download artifact"));
    await waitFor(() => {
      expect(menuItemByText("Download (.pptx)")).toBeInTheDocument();
    });
    click(menuItemByText("Download (.pptx)"));

    const exportFrame = await waitFor(() => {
      const frame = document.querySelector(
        'iframe[title="Presentation PPTX export"]',
      );
      expect(frame).toBeInstanceOf(HTMLIFrameElement);
      return frame as HTMLIFrameElement;
    });
    completePresentationPptxExport(exportFrame, await presentationPptxBlob());

    await waitFor(() => {
      expect(downloads).toContain("asset-backed-deck.pptx");
      expect(
        document.querySelector('iframe[title="Presentation PPTX export"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("edits a fallback presentation deck without embedded metadata", async () => {
    const presentationUrl = "https://deck.sites.vm7.io/legacy-launch-plan.html";
    const html = fallbackEditablePresentationHtml();
    let redeployedHtml: string | null = null;

    context.mocks.api(
      zeroHostContract.redeployPresentationHtml,
      ({ body, respond }) => {
        redeployedHtml = body.html;
        return respond(200, {
          siteId: "44444444-4444-4444-8444-444444444444",
          deploymentId: "55555555-5555-4555-8555-555555555555",
          publicSlug: "legacy-launch-plan",
          url: presentationUrl,
          status: "ready",
        });
      },
    );
    setupPresentationArtifactThread(presentationUrl, html);

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Edit presentation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Edit presentation"));

    await waitFor(() => {
      expect(screen.getByText("Presentation editor")).toBeInTheDocument();
      expect(screen.getByLabelText("Open slide 1")).toBeInTheDocument();
      expect(screen.getByLabelText("Speaker notes")).toHaveValue("");
    });

    await fill(
      screen.getByLabelText("Speaker notes"),
      "Use cleaned launch narrative.",
    );

    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close presentation editor"));

    await waitFor(() => {
      expect(screen.getByText("Presentation updated")).toBeInTheDocument();
      expect(screen.queryByText("Presentation editor")).not.toBeInTheDocument();
    });
    expect(redeployedHtml).toContain("vm0-deck-metadata");
    expect(redeployedHtml).toContain(
      '"speakerNotes": "Use cleaned launch narrative."',
    );
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Presentation updated"),
      ).not.toBeInTheDocument();
    });
  });

  it("edits and downloads a presentation artifact from the editor", async () => {
    const thumbnailObserver = mockIntersectionObserver();
    const presentationUrl = "https://deck.sites.vm7.io/quarterly-roadmap.html";
    const downloads = captureDownloads(context.signal);
    let generatedSlides: { slideId: string; speakerNotes: string }[] = [
      {
        slideId: "slide-plan",
        speakerNotes: "Generated hiring notes.",
      },
    ];
    context.mocks.api(
      zeroHostContract.redeployPresentationHtml,
      ({ respond }) => {
        return respond(200, {
          siteId: "22222222-2222-4222-8222-222222222222",
          deploymentId: "33333333-3333-4333-8333-333333333333",
          publicSlug: "quarterly-roadmap",
          url: presentationUrl,
          status: "ready",
        });
      },
    );
    context.mocks.api(
      zeroHostContract.generatePresentationSpeakerNotes,
      ({ respond }) => {
        return respond(200, {
          kind: "presentation-speaker-notes-patch",
          version: 1,
          slides: generatedSlides,
        });
      },
    );
    setupPresentationArtifactThread(presentationUrl);

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(screen.getByLabelText("Edit presentation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Edit presentation"));

    await waitFor(() => {
      expect(screen.getByText("Presentation editor")).toBeInTheDocument();
      expect(screen.getByLabelText("Speaker notes")).toHaveValue(
        "Open with launch metrics.",
      );
      expect(screen.getByLabelText("Open slide 2")).toBeInTheDocument();
    });

    thumbnailObserver.triggerAll();
    const slidePlanThumbnail = document.querySelector(
      'iframe[data-slide-thumbnail-frame="slide-plan"]',
    );
    expect(slidePlanThumbnail).toBeInstanceOf(HTMLIFrameElement);
    expect((slidePlanThumbnail as HTMLIFrameElement).src).toMatch(/^blob:/u);

    click(screen.getByLabelText("Open slide 2"));
    await waitFor(() => {
      expect(screen.getByLabelText("Speaker notes")).toHaveValue(
        "Explain the hiring plan.",
      );
    });

    const previewFrame = await waitFor(() => {
      const frame = document.querySelector(
        'iframe[title="Presentation preview"]',
      );
      expect(frame).toBeInstanceOf(HTMLIFrameElement);
      return frame as HTMLIFrameElement;
    });
    const previewDocument =
      previewFrame.contentDocument ??
      document.implementation.createHTMLDocument("presentation preview");
    Object.defineProperty(previewFrame, "contentDocument", {
      configurable: true,
      value: previewDocument,
    });
    previewDocument.body.innerHTML = [
      '<h1 data-vm0-editor-slide-id="slide-plan" data-vm0-editor-edit-id="plan">Hiring Plan</h1>',
      '<p data-vm0-editor-slide-id="slide-plan">Missing edit id</p>',
    ].join("");
    fireEvent.load(previewFrame);
    const editableTitle = previewDocument.querySelector(
      '[data-vm0-editor-edit-id="plan"]',
    );
    if (!(editableTitle instanceof HTMLElement)) {
      throw new Error("Presentation editable title not found");
    }
    await waitFor(() => {
      expect(editableTitle.getAttribute("contenteditable")).toBe("true");
      expect(editableTitle.getAttribute("role")).toBe("textbox");
    });
    editableTitle.textContent = "Revised Hiring Plan";
    editableTitle.dispatchEvent(new Event("input", { bubbles: true }));
    editableTitle.dispatchEvent(new FocusEvent("blur"));

    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    await fill(
      screen.getByLabelText("Speaker notes"),
      "Explain hiring and onboarding capacity.",
    );

    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Speaker notes"), " ");
    click(screen.getByLabelText("Generate PPT script"));

    await waitFor(() => {
      expect(
        screen.getByText("Added speaker notes to 1 slide"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Speaker notes")).toHaveValue(
        "Generated hiring notes.",
      );
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Added speaker notes to 1 slide"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Generate PPT script"));

    await waitFor(() => {
      expect(
        screen.getByText("All speaker notes are filled"),
      ).toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("All speaker notes are filled"),
      ).not.toBeInTheDocument();
    });

    generatedSlides = [
      {
        slideId: "missing-slide",
        speakerNotes: "This should not apply.",
      },
    ];
    await fill(screen.getByLabelText("Speaker notes"), " ");
    click(screen.getByLabelText("Generate PPT script"));

    await waitFor(() => {
      expect(
        screen.getByText("No speaker notes were added"),
      ).toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("No speaker notes were added"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Download edited PPTX"));
    await waitFor(() => {
      expect(screen.getByText("Presentation updated")).toBeInTheDocument();
    });
    const exportFrame = await waitFor(() => {
      const frame = document.querySelector(
        'iframe[title="Presentation PPTX export"]',
      );
      expect(frame).toBeInstanceOf(HTMLIFrameElement);
      return frame as HTMLIFrameElement;
    });
    completePresentationPptxExport(exportFrame, await presentationPptxBlob());
    await waitFor(() => {
      expect(downloads).toContain("quarterly-roadmap.pptx");
      expect(
        document.querySelector('iframe[title="Presentation PPTX export"]'),
      ).not.toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Presentation updated"),
      ).not.toBeInTheDocument();
    });

    await fill(
      screen.getByLabelText("Speaker notes"),
      "Try a failing PPTX export.",
    );
    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download edited PPTX"));
    await waitFor(() => {
      expect(screen.getByText("Presentation updated")).toBeInTheDocument();
    });
    const failedExportFrame = await waitFor(() => {
      const frame = document.querySelector(
        'iframe[title="Presentation PPTX export"]',
      );
      expect(frame).toBeInstanceOf(HTMLIFrameElement);
      return frame as HTMLIFrameElement;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          message: "Export failed",
          status: "error",
          type: "vm0-presentation-pptx-export",
        },
        source: failedExportFrame.contentWindow,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("PPTX download failed")).toBeInTheDocument();
      expect(
        document.querySelector('iframe[title="Presentation PPTX export"]'),
      ).not.toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("PPTX download failed"),
      ).not.toBeInTheDocument();
    });

    await fill(
      screen.getByLabelText("Speaker notes"),
      "Close with the onboarding capacity decision.",
    );
    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close presentation editor"));

    await waitFor(() => {
      expect(screen.getByText("Presentation updated")).toBeInTheDocument();
      expect(screen.queryByText("Presentation editor")).not.toBeInTheDocument();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Presentation updated"),
      ).not.toBeInTheDocument();
    });
  });

  it("browses artifact inbox sections, searches, and opens a result", async () => {
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    const imageUrl =
      "https://www.vm0.ai/f/36PnTFtD4dBQ9zg5jj6E5r918aV/24b42fb4-4b7b-4521-800f-defc356ae7b4/chart.png";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-demo.mp4";
    const audioUrl = "https://cdn.vm7.io/artifacts/test/run-1/voice-note.mp3";
    const htmlUrl = "https://cdn.vm7.io/artifacts/test/run-1/launch-site.html";
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

    const inbox = await waitFor(() => {
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
    expect(screen.getByTestId("artifact-sidebar-body-pdf")).toHaveAttribute(
      "title",
      "rollout-plan.pdf preview",
    );
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
