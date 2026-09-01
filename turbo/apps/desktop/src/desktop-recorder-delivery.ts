import path from "node:path";
import type { DesktopRecorderRecording } from "./desktop-recorder-types";

const VIDEO_CONTENT_TYPE = "video/mp4";
const CLICK_TRACK_CONTENT_TYPE = "application/json";

class DesktopRecorderDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopRecorderDeliveryError";
  }
}

export interface RecorderDeliveryDependencies {
  readonly apiBaseUrl: string;
  /** Origin the review link opens on, e.g. `https://app.okou.ai`. */
  readonly appUrl: string;
  /** Session-authenticated fetch against the Okou API. */
  readonly fetchWithSessionAuth: (
    url: URL,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * Unauthenticated fetch for the presigned R2 PUT. Deliberately separate: the
   * upload URL already carries its own signature, and sending Okou session
   * cookies to storage would leak them outside the API.
   */
  readonly fetchUpload: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Reads a file as a `Blob` so the bytes are a valid `BodyInit` regardless of
   * which ArrayBuffer flavour the platform read produced.
   */
  readonly readFile: (filePath: string) => Promise<Blob>;
  /** User the desktop is signed in as, carried so the browser can compare. */
  readonly userId: string;
}

export interface DeliveredRecording {
  readonly videoUploadId: string;
  readonly clickTrackUploadId: string;
  readonly reviewUrl: string;
}

interface PreparedUpload {
  readonly id: string;
  readonly uploadUrl: string;
  readonly uploadHeaders: Record<string, string>;
}

interface UploadedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function failureMessage(
  response: Response,
  action: string,
): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = body.slice(0, 200);
  return `${action} failed with ${response.status.toString()}${detail ? `: ${detail}` : ""}`;
}

async function prepareUpload(
  deps: RecorderDeliveryDependencies,
  file: {
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
  },
): Promise<PreparedUpload> {
  const response = await deps.fetchWithSessionAuth(
    new URL("/api/uploads/prepare", deps.apiBaseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.contentType,
        size: file.size,
      }),
    },
  );
  if (!response.ok) {
    throw new DesktopRecorderDeliveryError(
      await failureMessage(response, `Preparing the upload of ${file.name}`),
    );
  }

  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new DesktopRecorderDeliveryError(
      `Preparing the upload of ${file.name} returned no upload id`,
    );
  }
  if (typeof body.uploadUrl !== "string") {
    // The API only returns multipart parts when the request asks for them, and
    // a single PUT from the main process has no body-size limit to work around.
    throw new DesktopRecorderDeliveryError(
      `Preparing the upload of ${file.name} returned no direct upload URL`,
    );
  }

  const uploadHeaders = isRecord(body.uploadHeaders) ? body.uploadHeaders : {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(uploadHeaders)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return { id: body.id, uploadUrl: body.uploadUrl, uploadHeaders: headers };
}

async function uploadFile(
  deps: RecorderDeliveryDependencies,
  filePath: string,
  contentType: string,
): Promise<UploadedFile> {
  const name = path.basename(filePath);
  const body = await deps.readFile(filePath);
  const prepared = await prepareUpload(deps, {
    name,
    contentType,
    size: body.size,
  });

  const putResponse = await deps.fetchUpload(prepared.uploadUrl, {
    method: "PUT",
    headers: prepared.uploadHeaders,
    body,
  });
  if (!putResponse.ok) {
    throw new DesktopRecorderDeliveryError(
      await failureMessage(putResponse, `Uploading ${name}`),
    );
  }

  const completeResponse = await deps.fetchWithSessionAuth(
    new URL("/api/uploads/complete", deps.apiBaseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: prepared.id, contentType }),
    },
  );
  if (!completeResponse.ok) {
    throw new DesktopRecorderDeliveryError(
      await failureMessage(
        completeResponse,
        `Completing the upload of ${name}`,
      ),
    );
  }
  return { id: prepared.id, name, size: body.size };
}

/**
 * Uploads a finished recording and returns the link that opens it for review.
 *
 * The video and its click track are uploaded as two separate attachments so the
 * editor can consume the interaction data without parsing the video container.
 *
 * The review link carries the signed-in user id. Uploaded objects are owned by
 * the account that created them, so a browser signed in as somebody else would
 * otherwise fail to load the attachment with nothing explaining why.
 */
export async function deliverRecording(
  recording: DesktopRecorderRecording,
  deps: RecorderDeliveryDependencies,
): Promise<DeliveredRecording> {
  const videoUpload = await uploadFile(
    deps,
    recording.videoPath,
    VIDEO_CONTENT_TYPE,
  );
  const clickTrackUpload = await uploadFile(
    deps,
    recording.clickTrackPath,
    CLICK_TRACK_CONTENT_TYPE,
  );

  const reviewUrl = new URL("/", deps.appUrl);
  reviewUrl.searchParams.set("intro-video-recording", videoUpload.id);
  reviewUrl.searchParams.set("intro-video-recording-name", videoUpload.name);
  reviewUrl.searchParams.set(
    "intro-video-recording-size",
    videoUpload.size.toString(),
  );
  reviewUrl.searchParams.set("intro-video-clicks", clickTrackUpload.id);
  reviewUrl.searchParams.set("intro-video-clicks-name", clickTrackUpload.name);
  reviewUrl.searchParams.set(
    "intro-video-clicks-size",
    clickTrackUpload.size.toString(),
  );
  reviewUrl.searchParams.set("intro-video-user", deps.userId);

  return {
    videoUploadId: videoUpload.id,
    clickTrackUploadId: clickTrackUpload.id,
    reviewUrl: reviewUrl.toString(),
  };
}
