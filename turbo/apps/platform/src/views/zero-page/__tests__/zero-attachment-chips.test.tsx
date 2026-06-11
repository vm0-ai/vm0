import {
  chatThreadArtifactsContract,
  type ChatThreadArtifactFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-quarterly-roadmap",
    filename: "quarterly-roadmap.html",
    contentType: "text/html",
    artifactKind: "presentation-html",
    size: 1024,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
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
          "slide-intro": { "speakerNotes": "Open with launch metrics." }
        }
      }
    </script>
  </head>
  <body>
    <section data-vm0-slide data-slide-id="slide-intro">
      <h1 data-vm0-editable="text" data-vm0-edit-id="title">Quarterly roadmap</h1>
      <p data-vm0-editable="text" data-vm0-edit-id="summary">Launch metrics are ahead of plan.</p>
    </section>
  </body>
</html>`;
}

beforeEach(() => {
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    updatedAt: "2026-03-10T00:00:00Z",
  });
});

async function uploadFile(file: File): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await user.upload(fileInput, file);
}

async function setupComposer(): Promise<void> {
  detachedSetupPage({ context, path: "/" });

  await waitFor(() => {
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
}

async function setupUploadedImagePreview(): Promise<void> {
  context.mocks.upload.success({
    id: "upload-photo",
    filename: "photo.png",
    contentType: "image/png",
    size: 2048,
    url: "https://example.com/photo.png",
  });

  await setupComposer();
  await uploadFile(new File(["img"], "photo.png", { type: "image/png" }));

  await waitFor(() => {
    expect(
      screen.getByLabelText("Open image preview for photo.png"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
  });
}

function clipboardFileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => {
      return file;
    },
  } as DataTransferItem;
}

describe("zero attachment chips", () => {
  it("shows pending upload progress for composer attachments", async () => {
    context.mocks.upload.pending({
      id: "upload-pending",
      filename: "document.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/document.pdf",
    });

    await setupComposer();
    await uploadFile(
      new File(["data"], "document.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload document.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("uploads a pasted file and keeps pasted text in the composer", async () => {
    context.mocks.upload.success({
      id: "upload-pasted-notes",
      filename: "pasted-notes.txt",
      contentType: "text/plain",
      size: 18,
      url: "https://example.com/pasted-notes.txt",
    });

    await setupComposer();

    const composer = screen.getByPlaceholderText(PLACEHOLDER);
    const file = new File(["pasted file body"], "pasted-notes.txt", {
      type: "text/plain",
    });

    fireEvent.paste(composer, {
      clipboardData: {
        items: [clipboardFileItem(file)],
        getData: (type: string) => {
          return type === "text/plain" ? "Pasted context" : "";
        },
      },
    });

    await waitFor(() => {
      expect(composer).toHaveValue("Pasted context");
      expect(
        screen.getByLabelText("Remove pasted-notes.txt"),
      ).toBeInTheDocument();
    });
  });

  it("uploads a file dropped onto the composer", async () => {
    context.mocks.upload.success({
      id: "upload-dropped-report",
      filename: "dropped-report.pdf",
      contentType: "application/pdf",
      size: 128,
      url: "https://example.com/dropped-report.pdf",
    });

    await setupComposer();

    const composerCard = screen
      .getByPlaceholderText(PLACEHOLDER)
      .closest(".zero-composer");
    if (!(composerCard instanceof HTMLElement)) {
      throw new Error("Composer card not found");
    }

    fireEvent.dragOver(composerCard, {
      dataTransfer: {
        files: [
          new File(["dropped report"], "dropped-report.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    fireEvent.drop(composerCard, {
      dataTransfer: {
        files: [
          new File(["dropped report"], "dropped-report.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Remove dropped-report.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("shows completed image previews and removable composer chips", async () => {
    const imageUrl = "https://example.com/photo.png";

    await setupUploadedImagePreview();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open image preview for photo.png"),
      ).toBeInTheDocument();
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    const image = document.querySelector<HTMLImageElement>(
      `img[src="${imageUrl}"]`,
    );
    if (!image) {
      throw new Error("Composer image preview not found");
    }

    fireEvent.load(image);
    await waitFor(() => {
      expect(
        screen.queryByTestId("composer-image-preview-loading"),
      ).not.toBeInTheDocument();
    });

    fireEvent.error(image);
    await waitFor(() => {
      expect(
        screen.getByTestId("composer-image-preview-loading"),
      ).toBeInTheDocument();
    });
  });

  it("opens, zooms, and closes an uploaded image preview", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("removes an uploaded image preview from the composer", async () => {
    await setupUploadedImagePreview();

    click(screen.getByLabelText("Remove photo.png"));
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Open image preview for photo.png"),
      ).not.toBeInTheDocument();
    });
  });

  it("opens persisted audio, video, and document attachments from chat history", async () => {
    const audioUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-audio/briefing.mp3";
    const videoUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-video/demo.mp4";
    const jsonUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-json/status.json";
    context.mocks.http.get(jsonUrl, () => {
      return new Response(JSON.stringify({ status: "ready" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-attachments",
          role: "user",
          content: "Review these attachments",
          attachFiles: [
            {
              id: "attachment-audio",
              filename: "briefing.mp3",
              contentType: "audio/mpeg",
              size: 1024,
              url: audioUrl,
            },
            {
              id: "attachment-video",
              filename: "demo.mp4",
              contentType: "video/mp4",
              size: 2048,
              url: videoUrl,
            },
            {
              id: "attachment-json",
              filename: "status.json",
              contentType: "application/json",
              size: 32,
              url: jsonUrl,
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Review these attachments")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open audio preview for briefing.mp3"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open json preview for status.json"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open audio preview for briefing.mp3"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-audio")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Preview demo.mp4"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Video preview for demo.mp4"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-video"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifact"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open json preview for status.json"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText(/"status": "ready"/u)).toBeInTheDocument();
    });
  });

  it("opens persisted csv, pdf, and html document previews from chat history", async () => {
    const csvUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-csv/launch-metrics.csv";
    const pdfUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-pdf/launch-plan.pdf";
    const htmlUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-html/launch-site.html";
    context.mocks.http.get(csvUrl, () => {
      return new Response("metric,value\nsignups,42\nactivation,87", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-document-previews",
          role: "user",
          content: "Review these document previews",
          attachFiles: [
            {
              id: "attachment-csv",
              filename: "launch-metrics.csv",
              contentType: "text/csv",
              size: 38,
              url: csvUrl,
            },
            {
              id: "attachment-pdf",
              filename: "launch-plan.pdf",
              contentType: "application/pdf",
              size: 2048,
              url: pdfUrl,
            },
            {
              id: "attachment-html",
              filename: "launch-site.html",
              contentType: "text/html",
              size: 4096,
              url: htmlUrl,
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByText("Review these document previews"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for launch-metrics.csv"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for launch-plan.pdf"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for launch-site.html"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open csv preview for launch-metrics.csv"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("metric")).toBeInTheDocument();
      expect(screen.getByText("activation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open pdf preview for launch-plan.pdf"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-document-frame"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for launch-site.html"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-body-html"),
      ).toBeInTheDocument();
    });
  });

  it("opens presentation artifact controls from chat message links", async () => {
    const presentationUrl =
      "https://cdn.vm7.io/artifacts/test/body-presentation/quarterly-roadmap.html";
    const html = presentationHtml();
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
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, {
        runs: [
          {
            runId: "run-presentation",
            files: [artifactFile(presentationUrl)],
          },
        ],
      });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-presentation-artifact",
          role: "assistant",
          content: `[Quarterly roadmap](${presentationUrl})`,
          runId: "run-presentation",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.PresentationHtmlPptxDownload]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for Quarterly roadmap"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Quarterly roadmap"));

    await waitFor(() => {
      expect(screen.getByLabelText("Edit presentation")).toBeInTheDocument();
      expect(screen.getByLabelText("Open in split view")).toBeInTheDocument();
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Enter fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Exit fullscreen"));

    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open in split view"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        screen.getByTestId("artifact-sidebar-body-html"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close artifact"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Quarterly roadmap"));
    click(await screen.findByLabelText("Edit presentation"));

    await waitFor(() => {
      expect(screen.getByText("Presentation editor")).toBeInTheDocument();
    });
  });

  it("opens media and file previews parsed from chat message links", async () => {
    const audioUrl =
      "https://cdn.vm7.io/artifacts/test/body-audio/briefing.mp3";
    const videoUrl = "https://cdn.vm7.io/artifacts/test/body-video/demo.mp4";
    const imageUrl = "https://cdn.vm7.io/artifacts/test/body-image/chart.png";
    const markdownUrl =
      "https://cdn.vm7.io/artifacts/test/body-markdown/release-notes.md";
    const csvUrl =
      "https://cdn.vm7.io/artifacts/test/body-csv/launch-metrics.csv";
    const pdfUrl =
      "https://cdn.vm7.io/artifacts/test/body-pdf/rollout-plan.pdf";
    const htmlUrl =
      "https://cdn.vm7.io/artifacts/test/body-html/launch-site.html";
    const archiveUrl =
      "https://cdn.vm7.io/artifacts/test/body-file/archive.bin";
    context.mocks.http.get(markdownUrl, () => {
      return new Response("# Release notes\n\nBody link rollout is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(csvUrl, () => {
      return new Response("metric,value\nactivation,87", {
        headers: { "Content-Type": "text/csv" },
      });
    });
    context.mocks.http.get(archiveUrl, () => {
      return new Response(null, { status: 500 });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-body-preview-links",
          role: "assistant",
          content: `Generated preview links:\n\n${audioUrl}\n${videoUrl}\n${imageUrl}\n${markdownUrl}\n${csvUrl}\n${pdfUrl}\n[Launch site](${htmlUrl})\n${archiveUrl}`,
          runId: "run-body-previews",
          status: "completed",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Generated preview links:")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open audio preview for briefing.mp3"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for release-notes.md"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for launch-metrics.csv"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for rollout-plan.pdf"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for Launch site"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Download archive.bin")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open audio preview for briefing.mp3"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-dialog-audio")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Preview demo.mp4"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Video preview for demo.mp4"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    fireEvent.load(screen.getByAltText("chart.png"));
    click(screen.getByLabelText("Preview chart.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(
        screen.getByText("Body link rollout is ready."),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open csv preview for launch-metrics.csv"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("activation")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open pdf preview for rollout-plan.pdf"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-document-frame"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open html preview for Launch site"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-body-html"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Download archive.bin"));

    await waitFor(() => {
      expect(screen.getByText("Download failed")).toBeInTheDocument();
    });
  });

  it("opens markdown and text previews, shares a document link, and reports download failures", async () => {
    const releaseNotesUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-markdown/release-notes.md";
    const transcriptUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-text/transcript.txt";
    const archiveUrl =
      "https://cdn.vm7.io/artifacts/test/attachment-file/archive.bin";
    context.mocks.browser.clipboardWriteText();
    context.mocks.http.get(releaseNotesUrl, () => {
      return new Response("# Release notes\n\nThe rollout is ready.", {
        headers: { "Content-Type": "text/markdown" },
      });
    });
    context.mocks.http.get(transcriptUrl, () => {
      return new Response("Meeting transcript\nDecision: ship", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    context.mocks.http.get(archiveUrl, () => {
      return new Response(null, { status: 500 });
    });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-text-previews",
          role: "user",
          content: "Review these text attachments",
          attachFiles: [
            {
              id: "attachment-markdown",
              filename: "release-notes.md",
              contentType: "text/markdown",
              size: 42,
              url: releaseNotesUrl,
            },
            {
              id: "attachment-text",
              filename: "transcript.txt",
              contentType: "text/plain",
              size: 33,
              url: transcriptUrl,
            },
            {
              id: "attachment-file",
              filename: "archive.bin",
              contentType: "application/octet-stream",
              size: 4096,
              url: archiveUrl,
            },
          ],
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByText("Review these text attachments"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for release-notes.md"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open text preview for transcript.txt"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Download archive.bin")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open markdown preview for release-notes.md"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText("The rollout is ready.")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Share"));

    await waitFor(() => {
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Open text preview for transcript.txt"));

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(screen.getByText(/Decision: ship/u)).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Download archive.bin"));

    await waitFor(() => {
      expect(screen.getByText("Download failed")).toBeInTheDocument();
    });
  });
});
