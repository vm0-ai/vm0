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
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { toast } from "@vm0/ui/components/ui/sonner";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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
      status: "completed",
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
      latestSessionId: null,
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
      totalCount: 0,
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

function setupPresentationArtifactThread(presentationUrl: string): void {
  context.mocks.http.get(presentationUrl, () => {
    return new Response(presentationHtml(), {
      headers: { "Content-Type": "text/html" },
    });
  });
  context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
    return new Response(presentationHtml(), {
      headers: { "Content-Type": "text/html" },
    });
  });
  setupChatThread({
    artifactFiles: [
      artifactFile(presentationUrl, {
        id: "artifact-quarterly-roadmap",
        filename: "quarterly-roadmap.html",
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

function getArtifactTab(container: HTMLElement, label: string): HTMLElement {
  const tab = queryAllByRoleFast("tab", container).find((element) => {
    return element.textContent?.trim() === label;
  });
  if (!tab) {
    throw new Error(`${label} artifact tab not found`);
  }
  return tab;
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
  });

  it("shares an artifact and exposes download destinations from the sidebar", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
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
  });

  it("connects Google Drive from the sidebar and syncs an artifact", async () => {
    const user = userEvent.setup({ delay: null });
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/run-1/release-notes.md";
    const artifactFiles = [artifactFile(markdownUrl)];
    const authWindow = context.mocks.browser.authWindow();
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nThe artifact is ready.", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.type}/authorize`,
        });
      },
    );
    context.mocks.api(
      chatThreadArtifactsContract.syncGoogleDrive,
      ({ respond }) => {
        artifactFiles[0] = {
          ...artifactFiles[0]!,
          googleDriveSync: {
            status: "synced",
            id: "drive-file-release-notes",
            name: "release-notes.md",
            webViewLink: "https://drive.test/release-notes",
          },
        };
        return respond(200, {
          id: "drive-file-release-notes",
          name: "release-notes.md",
          webViewLink: "https://drive.test/release-notes",
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
      expect(menuItemByText("Connect Google Drive")).toBeInTheDocument();
    });

    click(menuItemByText("Connect Google Drive"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/google-drive/authorize",
      );
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeTruthy();
    });

    context.mocks.data.connectors([googleDriveConnector()]);
    context.mocks.ably.trigger("connector:changed");

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

  it("edits and downloads a presentation artifact from the editor", async () => {
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

    click(screen.getByLabelText("Open slide 2"));
    await waitFor(() => {
      expect(screen.getByLabelText("Speaker notes")).toHaveValue(
        "Explain the hiring plan.",
      );
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

    click(screen.getByLabelText("Back to all artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(screen.getByText("release-notes.md")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifacts"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-inbox")).not.toBeInTheDocument();
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });
  });
});
