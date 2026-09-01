import { describe, expect, it, vi } from "vitest";
import { deliverRecording } from "./desktop-recorder-delivery";
import type { RecorderDeliveryDependencies } from "./desktop-recorder-delivery";
import type { DesktopRecorderRecording } from "./desktop-recorder-types";

const RECORDING: DesktopRecorderRecording = {
  videoPath: "/recordings/screen-recording-1.mp4",
  clickTrackPath: "/recordings/screen-recording-1.clicks.json",
  durationMs: 42_130,
  sizeBytes: 8_912_345,
  width: 1920,
  height: 1200,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createDependencies(
  overrides: Partial<RecorderDeliveryDependencies> = {},
): RecorderDeliveryDependencies {
  let prepared = 0;
  return {
    apiBaseUrl: "https://api.vm0.ai",
    appUrl: "https://app.okou.ai",
    userId: "user_1",
    readFile: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])])),
    fetchWithSessionAuth: vi.fn(async (url: URL) => {
      if (url.pathname === "/api/uploads/prepare") {
        prepared += 1;
        return jsonResponse({
          id: `upload-${prepared.toString()}`,
          uploadUrl: `https://r2.example/put/${prepared.toString()}`,
          uploadHeaders: { "content-type": "application/octet-stream" },
        });
      }
      return jsonResponse({ id: `upload-${prepared.toString()}` });
    }),
    fetchUpload: vi.fn(async () => new Response(null, { status: 200 })),
    ...overrides,
  };
}

describe("deliverRecording", () => {
  it("uploads the video and the click track as separate attachments", async () => {
    const deps = createDependencies();

    const delivered = await deliverRecording(RECORDING, deps);

    expect(delivered.videoUploadId).toBe("upload-1");
    expect(delivered.clickTrackUploadId).toBe("upload-2");
    expect(deps.readFile).toHaveBeenCalledWith(RECORDING.videoPath);
    expect(deps.readFile).toHaveBeenCalledWith(RECORDING.clickTrackPath);
  });

  it("declares each file with its own name, type, and byte length", async () => {
    const deps = createDependencies();

    await deliverRecording(RECORDING, deps);

    const prepareCalls = vi
      .mocked(deps.fetchWithSessionAuth)
      .mock.calls.filter(([url]) => {
        return url.pathname === "/api/uploads/prepare";
      });
    expect(JSON.parse(String(prepareCalls[0]?.[1]?.body))).toEqual({
      filename: "screen-recording-1.mp4",
      contentType: "video/mp4",
      size: 4,
    });
    expect(JSON.parse(String(prepareCalls[1]?.[1]?.body))).toEqual({
      filename: "screen-recording-1.clicks.json",
      contentType: "application/json",
      size: 4,
    });
  });

  it("sends the file body to the presigned URL without session credentials", async () => {
    const deps = createDependencies();

    await deliverRecording(RECORDING, deps);

    expect(deps.fetchUpload).toHaveBeenCalledWith(
      "https://r2.example/put/1",
      expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  });

  it("builds a review link carrying both uploads and the signed-in user", async () => {
    const deps = createDependencies();

    const delivered = await deliverRecording(RECORDING, deps);
    const url = new URL(delivered.reviewUrl);

    expect(url.origin).toBe("https://app.okou.ai");
    expect(url.searchParams.get("intro-video-recording")).toBe("upload-1");
    expect(url.searchParams.get("intro-video-clicks")).toBe("upload-2");
    // Uploads are owned by the account that created them, so the browser needs
    // to know which account the desktop was signed in as.
    expect(url.searchParams.get("intro-video-user")).toBe("user_1");
  });

  it("reports which step failed and its status", async () => {
    const deps = createDependencies({
      fetchUpload: vi.fn(
        async () => new Response("slow down", { status: 503 }),
      ),
    });

    await expect(deliverRecording(RECORDING, deps)).rejects.toThrow(
      "Uploading screen-recording-1.mp4 failed with 503: slow down",
    );
  });

  it("stops before uploading when the session is rejected", async () => {
    const deps = createDependencies({
      fetchWithSessionAuth: vi.fn(async () =>
        jsonResponse({ error: "unauthorized" }, 401),
      ),
    });

    await expect(deliverRecording(RECORDING, deps)).rejects.toThrow(
      "Preparing the upload of screen-recording-1.mp4 failed with 401",
    );
    expect(deps.fetchUpload).not.toHaveBeenCalled();
  });

  it("refuses a multipart response it did not ask for", async () => {
    const deps = createDependencies({
      fetchWithSessionAuth: vi.fn(async () =>
        jsonResponse({
          id: "upload-1",
          multipart: { uploadId: "m1", partSize: 1024, parts: [] },
        }),
      ),
    });

    await expect(deliverRecording(RECORDING, deps)).rejects.toThrow(
      "returned no direct upload URL",
    );
  });
});
