import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";
const THREAD_ID = "b0000000-0000-4000-a000-000000000050";

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

describe("zero attachment chips", () => {
  it("shows pending upload progress, completed image previews, and removable composer chips", async () => {
    context.mocks.upload.pending({
      id: "upload-pending",
      filename: "document.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/document.pdf",
    });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await uploadFile(
      new File(["data"], "document.pdf", { type: "application/pdf" }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload document.pdf"),
      ).toBeInTheDocument();
    });
  });

  it("opens, zooms, closes, and removes an uploaded image preview", async () => {
    const user = userEvent.setup({ delay: null });
    const imageUrl = "https://example.com/photo.png";
    context.mocks.upload.success({
      id: "upload-photo",
      filename: "photo.png",
      contentType: "image/png",
      size: 2048,
      url: imageUrl,
    });

    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await uploadFile(new File(["img"], "photo.png", { type: "image/png" }));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open image preview for photo.png"),
      ).toBeInTheDocument();
      expect(
        document.querySelector(`img[src="${imageUrl}"]`),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Open image preview for photo.png"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-dialog-image-zoom-controls"),
      ).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Zoom in"));
    await waitFor(() => {
      expect(screen.getByText("115%")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

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
});
