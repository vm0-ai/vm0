import { statSync } from "node:fs";

import {
  ZERO_RECOGNITION_MAX_FILE_BYTES,
  ZERO_RECOGNITION_MAX_PROMPT_CHARS,
  zeroRecognitionImageMimeTypeSchema,
  type ZeroRecognitionImageMimeType,
} from "@vm0/api-contracts/contracts/zero-recognition";
import { Command } from "commander";

import {
  ApiRequestError,
  callZeroRecognition,
  inferWebUploadContentType,
  uploadWebFile,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface RecognizeOptions {
  readonly file: string;
  readonly prompt: string;
}

function validatePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ApiRequestError(
      "Recognition prompt must not be empty",
      "BAD_REQUEST",
      400,
    );
  }
  if (trimmed.length > ZERO_RECOGNITION_MAX_PROMPT_CHARS) {
    throw new ApiRequestError(
      `Recognition prompt must be ${ZERO_RECOGNITION_MAX_PROMPT_CHARS} characters or fewer`,
      "BAD_REQUEST",
      400,
    );
  }
  return trimmed;
}

function validateImageFile(file: string): ZeroRecognitionImageMimeType {
  const stats = statSync(file);
  if (!stats.isFile()) {
    throw new ApiRequestError(
      `Not a regular file: ${file}`,
      "BAD_REQUEST",
      400,
    );
  }
  if (stats.size === 0) {
    throw new ApiRequestError(
      "Image file must not be empty",
      "BAD_REQUEST",
      400,
    );
  }
  if (stats.size > ZERO_RECOGNITION_MAX_FILE_BYTES) {
    throw new ApiRequestError(
      "Image file must be 20 MB or smaller",
      "PAYLOAD_TOO_LARGE",
      413,
    );
  }

  const contentType = inferWebUploadContentType(file);
  const parsed = zeroRecognitionImageMimeTypeSchema.safeParse(contentType);
  if (!parsed.success) {
    throw new ApiRequestError(
      "Image must be a PNG, JPEG, or WebP file",
      "BAD_REQUEST",
      400,
    );
  }
  return parsed.data;
}

export const zeroRecognizeCommand = new Command()
  .name("recognize")
  .description("Recognize one image through a managed multimodal model")
  .requiredOption("-f, --file <path>", "Local PNG, JPEG, or WebP image")
  .requiredOption("-p, --prompt <instruction>", "Recognition instruction")
  .action(
    withErrorHandler(async (options: RecognizeOptions) => {
      const prompt = validatePrompt(options.prompt);
      const contentType = validateImageFile(options.file);
      const uploaded = await uploadWebFile(options.file, { contentType });
      const response = await callZeroRecognition({
        fileId: uploaded.id,
        prompt,
      });
      console.log(response.text);
    }),
  )
  .addHelpText(
    "after",
    `
Example:
  zero recognize --file ./screenshot.png --prompt "Describe the error shown"

Notes:
  - Available only in runs whose selected model does not support image input
  - Accepts one PNG, JPEG, or WebP image up to 20 MB
  - Uses a fixed vm0-managed recognition model and prints only recognized text`,
  );
