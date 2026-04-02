import { uploadS3Buffer, generatePresignedUrl } from "../infra/s3/s3-client";
import { env } from "../../env";
import {
  getReceivedEmailAttachments,
  type ReceivedEmailAttachment,
} from "./client";
import { logger } from "../logger";

const log = logger("email:attachment");

/** Maximum attachment size to download and upload (10MB) */
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

/** Presigned URL expiry in seconds (1 hour) */
const PRESIGNED_URL_EXPIRY = 3600;

/** R2 key prefix for email attachments */
const R2_PATH_PREFIX = "email-attachments";

/**
 * Download a single email attachment from Resend and upload to R2.
 * Returns a presigned URL that the agent can access, or null on failure.
 */
async function downloadAndUploadEmailAttachment(
  attachment: ReceivedEmailAttachment,
  emailId: string,
): Promise<string | null> {
  if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
    log.debug("Attachment too large to upload", {
      attachmentId: attachment.id,
      size: attachment.size,
      maxSize: MAX_ATTACHMENT_SIZE_BYTES,
    });
    return null;
  }

  let buffer: Buffer;
  try {
    const response = await fetch(attachment.download_url);

    if (!response.ok) {
      log.debug("Failed to download email attachment", {
        attachmentId: attachment.id,
        status: response.status,
      });
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    log.debug("Error downloading email attachment", {
      attachmentId: attachment.id,
      error,
    });
    return null;
  }

  const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
  const s3Key = `${R2_PATH_PREFIX}/${emailId}/${attachment.id}-${attachment.filename}`;

  await uploadS3Buffer(bucketName, s3Key, buffer, attachment.content_type);

  const presignedUrl = await generatePresignedUrl(
    bucketName,
    s3Key,
    PRESIGNED_URL_EXPIRY,
  );

  log.debug("Uploaded email attachment to R2", {
    attachmentId: attachment.id,
    filename: attachment.filename,
    size: buffer.length,
    s3Key,
  });

  return presignedUrl;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format a successfully uploaded attachment for the prompt.
 */
function formatEmailAttachment(
  attachment: ReceivedEmailAttachment,
  presignedUrl: string,
): string {
  const parts: string[] = [];
  parts.push(
    `[attachment]: ${attachment.filename} (${attachment.content_type}, ${formatSize(attachment.size)})`,
  );
  parts.push(`   URL: ${presignedUrl}`);
  parts.push(
    `   To access this file: curl -sS -o /tmp/${attachment.filename} "${presignedUrl}" && read the downloaded file`,
  );
  return parts.join("\n");
}

/**
 * Format a skipped attachment for the prompt.
 */
function formatEmailAttachmentSkipped(
  attachment: ReceivedEmailAttachment,
  reason: string,
): string {
  return `[attachment]: ${attachment.filename} (${attachment.content_type}, ${formatSize(attachment.size)}) — skipped: ${reason}`;
}

/**
 * Process all attachments for a received email.
 * Downloads each attachment from Resend, uploads to R2, and returns
 * a formatted prompt text block with attachment URLs.
 *
 * Returns an empty string if there are no attachments.
 */
export async function processEmailAttachments(
  emailId: string,
): Promise<string> {
  const attachments = await getReceivedEmailAttachments(emailId);

  if (attachments.length === 0) {
    return "";
  }

  const lines = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) {
        return formatEmailAttachmentSkipped(attachment, "exceeds size limit");
      }

      const presignedUrl = await downloadAndUploadEmailAttachment(
        attachment,
        emailId,
      );

      if (presignedUrl) {
        return formatEmailAttachment(attachment, presignedUrl);
      }
      return formatEmailAttachmentSkipped(attachment, "download failed");
    }),
  );

  return lines.join("\n\n");
}
