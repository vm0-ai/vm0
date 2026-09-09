import {
  GetObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";

const MAX_CLICK_TRACK_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNumbers(value: unknown, fields: readonly string[]): boolean {
  return (
    isRecord(value) &&
    fields.every((field) => {
      return typeof value[field] === "number" && Number.isFinite(value[field]);
    })
  );
}

// Frozen signature shared by the historical v1 recorder variants. Newer v1
// tracks add content, pointerEvents and typingBursts; these are not required to
// identify the JSON format. This does not validate playback behavior.
function isClickTrack(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.recording)) return false;
  const recording = value.recording;
  return (
    value.version === 1 &&
    hasNumbers(recording, ["startedAtUnixMs", "durationMs"]) &&
    hasNumbers(recording.video, ["width", "height", "frameRate"]) &&
    hasNumbers(recording.capture, [
      "originX",
      "originY",
      "widthPoints",
      "heightPoints",
      "scale",
    ]) &&
    Array.isArray(value.clicks) &&
    typeof value.droppedOutOfFrameClicks === "number" &&
    Number.isSafeInteger(value.droppedOutOfFrameClicks) &&
    value.droppedOutOfFrameClicks >= 0 &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => {
      return typeof warning === "string";
    })
  );
}

/**
 * Old Desktop uploads supplied application/json to prepare/complete, but their
 * Blob PUT could omit Content-Type and no DB row exists before chat attachment.
 * Recover only a bounded, verified recorder JSON body. Keep this frozen with
 * migration 014 until historical delivery is retired under #32492.
 */
export async function resolveLegacyClickTrackContentType(
  client: S3Client,
  bucket: string,
  key: string,
  filename: string,
  head: HeadObjectCommandOutput,
): Promise<string | undefined> {
  if (
    !/^artifacts\/[a-z0-9]{10}\.json$/u.test(key) ||
    !/^screen-recording-\d+\.clicks\.json$/u.test(filename)
  )
    return undefined;

  const size = head.ContentLength;
  if (
    size === undefined ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_CLICK_TRACK_BYTES ||
    !head.ETag
  )
    throw new Error(`Historical click track has no bounded identity: ${key}`);

  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: head.ETag,
      Range: `bytes=0-${size - 1}`,
    }),
  );
  if (
    !result.Body ||
    result.ContentLength !== size ||
    result.ETag !== head.ETag
  )
    throw new Error(`Historical click track changed during inventory: ${key}`);
  const bytes = await result.Body.transformToByteArray();
  if (bytes.byteLength !== size)
    throw new Error(`Historical click track body length mismatch: ${key}`);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Do not expose artifact contents through JSON parser errors in job logs.
    throw new Error(`Historical click track is not valid UTF-8 JSON: ${key}`);
  }
  if (!isClickTrack(value))
    throw new Error(
      `Historical click track has an unrecognized format: ${key}`,
    );
  return "application/json";
}
