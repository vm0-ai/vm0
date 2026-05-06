/** Maximum file size to download (10MB) */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export type TelegramFileContextType =
  | "photo"
  | "document"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "video_note"
  | "sticker";

/** Minimal photo fields needed for picking the best size */
interface PhotoSizeLike {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramFileContext {
  file_id: string;
  file_type: TelegramFileContextType;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

interface TelegramAttachmentMessageLike {
  photo?: PhotoSizeLike[];
  document?: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    width: number;
    height: number;
    duration: number;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    duration: number;
    performer?: string;
    title?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  animation?: {
    file_id: string;
    width: number;
    height: number;
    duration: number;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video_note?: {
    file_id: string;
    length: number;
    duration: number;
    file_size?: number;
  };
  sticker?: {
    file_id: string;
    type?: string;
    width: number;
    height: number;
    emoji?: string;
    file_size?: number;
  };
}

/**
 * Pick the best photo size from Telegram's array.
 * Telegram provides multiple sizes; pick the largest that's within our size limit.
 */
export function pickBestPhoto<T extends PhotoSizeLike>(
  photos: T[],
): T | undefined {
  if (photos.length === 0) {
    return undefined;
  }

  // Sort by area descending, pick first that fits size limit
  const sorted = [...photos].sort((a, b) => {
    return b.width * b.height - a.width * a.height;
  });

  for (const photo of sorted) {
    if (!photo.file_size || photo.file_size <= MAX_FILE_SIZE_BYTES) {
      return photo;
    }
  }

  // All too large — pick the smallest
  return sorted[sorted.length - 1];
}

function defaultMimeType(fileType: TelegramFileContextType): string {
  switch (fileType) {
    case "photo":
      return "image/jpeg";
    case "video":
    case "animation":
    case "video_note":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "voice":
      return "audio/ogg";
    case "sticker":
      return "image/webp";
    case "document":
      return "application/octet-stream";
  }
}

function displayType(fileType: TelegramFileContextType): string {
  return fileType.replace("_", " ");
}

function maybeAudioName(
  audio: NonNullable<TelegramAttachmentMessageLike["audio"]>,
) {
  if (audio.file_name) return audio.file_name;
  if (audio.performer && audio.title)
    return `${audio.performer} - ${audio.title}`;
  return audio.title ?? undefined;
}

export function extractTelegramFileForContext(
  message: TelegramAttachmentMessageLike,
): TelegramFileContext | undefined {
  const bestPhoto = message.photo ? pickBestPhoto(message.photo) : undefined;
  if (bestPhoto) {
    return {
      file_id: bestPhoto.file_id,
      file_type: "photo",
      mime_type: "image/jpeg",
      file_size: bestPhoto.file_size,
      width: bestPhoto.width,
      height: bestPhoto.height,
    };
  }

  if (message.document) {
    return {
      file_id: message.document.file_id,
      file_type: "document",
      file_name: message.document.file_name,
      mime_type: message.document.mime_type,
      file_size: message.document.file_size,
    };
  }

  if (message.video) {
    return {
      file_id: message.video.file_id,
      file_type: "video",
      file_name: message.video.file_name,
      mime_type: message.video.mime_type,
      file_size: message.video.file_size,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
    };
  }

  if (message.audio) {
    return {
      file_id: message.audio.file_id,
      file_type: "audio",
      file_name: maybeAudioName(message.audio),
      mime_type: message.audio.mime_type,
      file_size: message.audio.file_size,
      duration: message.audio.duration,
    };
  }

  if (message.voice) {
    return {
      file_id: message.voice.file_id,
      file_type: "voice",
      mime_type: message.voice.mime_type,
      file_size: message.voice.file_size,
      duration: message.voice.duration,
    };
  }

  if (message.animation) {
    return {
      file_id: message.animation.file_id,
      file_type: "animation",
      file_name: message.animation.file_name,
      mime_type: message.animation.mime_type,
      file_size: message.animation.file_size,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
    };
  }

  if (message.video_note) {
    return {
      file_id: message.video_note.file_id,
      file_type: "video_note",
      mime_type: "video/mp4",
      file_size: message.video_note.file_size,
      width: message.video_note.length,
      height: message.video_note.length,
      duration: message.video_note.duration,
    };
  }

  if (message.sticker) {
    return {
      file_id: message.sticker.file_id,
      file_type: "sticker",
      file_name: message.sticker.emoji,
      mime_type:
        message.sticker.type === "video"
          ? "video/webm"
          : message.sticker.type === "animated"
            ? "application/x-tgsticker"
            : "image/webp",
      file_size: message.sticker.file_size,
      width: message.sticker.width,
      height: message.sticker.height,
    };
  }

  return undefined;
}

export function hasTelegramFileForContext(
  message: TelegramAttachmentMessageLike,
): boolean {
  return extractTelegramFileForContext(message) !== undefined;
}

/**
 * Format a Telegram file reference for the agent prompt.
 *
 * Mirrors Slack file context: describe the attachment itself (name, type,
 * dimensions, id) and include the bot id needed by `zero telegram download-file`.
 */
export function formatTelegramFileForContext(
  file: TelegramFileContext | (PhotoSizeLike & { file_type?: "photo" }),
  opts?: { botId?: string },
): string {
  const fileType = file.file_type ?? "photo";
  const mimeType = "mime_type" in file ? file.mime_type : undefined;
  const parts: string[] = [];
  const name =
    "file_name" in file && file.file_name
      ? file.file_name
      : displayType(fileType);
  const type = mimeType ?? defaultMimeType(fileType);
  parts.push(`[Telegram file] ${name} (${type})`);

  const width = "width" in file ? file.width : undefined;
  const height = "height" in file ? file.height : undefined;
  if (width && height) {
    parts.push(`   [Dimensions] ${width}x${height}`);
  }

  parts.push(`   [ID] ${file.file_id}`);
  if (opts?.botId) {
    parts.push(`   [Bot ID] ${opts.botId}`);
  }
  return parts.join("\n");
}
