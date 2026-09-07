import { statSync } from "node:fs";

import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
  IMAGE_RECOGNITION_MAX_PROMPT_CHARS,
  imageRecognitionMimeTypeSchema,
  type ImageRecognitionRequest,
  type ImageRecognitionResponse,
  type ImageRecognitionMimeType,
} from "@okouai/api-contracts/contracts/image-recognition";
import { Command } from "commander";

import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  callImageRecognition,
  callImageRecognitionCompatibility,
} from "../../lib/api/domains/image-recognition";
import {
  inferWebUploadContentType,
  uploadWebFile,
} from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface ImageRecognitionOptions {
  readonly file: string;
  readonly prompt: string;
}

type ImageRecognitionCaller = (
  body: ImageRecognitionRequest,
) => Promise<ImageRecognitionResponse>;

interface ImageRecognitionCommandConfig {
  readonly name: "image-recognition" | "recognize";
  readonly description: string;
  readonly compatibilityNotice?: string;
  readonly call: ImageRecognitionCaller;
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
  if (trimmed.length > IMAGE_RECOGNITION_MAX_PROMPT_CHARS) {
    throw new ApiRequestError(
      `Recognition prompt must be ${IMAGE_RECOGNITION_MAX_PROMPT_CHARS} characters or fewer`,
      "BAD_REQUEST",
      400,
    );
  }
  return trimmed;
}

function validateImageFile(file: string): ImageRecognitionMimeType {
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
  if (stats.size > IMAGE_RECOGNITION_MAX_FILE_BYTES) {
    throw new ApiRequestError(
      "Image file must be 20 MB or smaller",
      "PAYLOAD_TOO_LARGE",
      413,
    );
  }

  const contentType = inferWebUploadContentType(file);
  const parsed = imageRecognitionMimeTypeSchema.safeParse(contentType);
  if (!parsed.success) {
    throw new ApiRequestError(
      "Image must be a PNG, JPEG, or WebP file",
      "BAD_REQUEST",
      400,
    );
  }
  return parsed.data;
}

function createImageRecognitionCommand(
  config: ImageRecognitionCommandConfig,
): Command {
  const compatibilityNotice = config.compatibilityNotice
    ? `${config.compatibilityNotice}\n\n`
    : "";

  return new Command()
    .name(config.name)
    .description(config.description)
    .requiredOption("-f, --file <path>", "Local PNG, JPEG, or WebP image")
    .requiredOption("-p, --prompt <instruction>", "Recognition instruction")
    .action(
      withErrorHandler(async (options: ImageRecognitionOptions) => {
        const prompt = validatePrompt(options.prompt);
        const contentType = validateImageFile(options.file);
        const uploaded = await uploadWebFile(options.file, { contentType });
        const response = await config.call({
          fileId: uploaded.id,
          prompt,
        });
        console.log(response.text);
      }),
    )
    .addHelpText(
      "after",
      `
${compatibilityNotice}Example:
  okou ${config.name} --file ./screenshot.png --prompt "Describe the error shown"

Notes:
  - Available only in runs whose selected model does not support image input
  - Accepts one PNG, JPEG, or WebP image up to 20 MB
  - Uses a fixed Okou-managed recognition model and prints only recognized text`,
    );
}

export const imageRecognitionCommand = createImageRecognitionCommand({
  name: "image-recognition",
  description: "Recognize one image through a managed multimodal model",
  call: callImageRecognition,
});

// Compatibility for immutable execution contexts whose guidance still invokes
// `okou recognize`. Keep until canonical guidance has shipped, every pre-switch
// context has drained through queue, execution, and finalization, and supported
// external callers no longer use the old command. Remove in the evidence-backed
// cleanup phase tracked by #26929.
export const imageRecognitionCompatibilityCommand =
  createImageRecognitionCommand({
    name: "recognize",
    description: "Compatibility command for okou image-recognition",
    compatibilityNotice:
      "Compatibility:\n  Use okou image-recognition for new invocations.",
    call: callImageRecognitionCompatibility,
  });
