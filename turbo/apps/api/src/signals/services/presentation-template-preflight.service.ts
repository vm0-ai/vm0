import { command } from "ccstate";
import { MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES } from "@vm0/api-contracts/contracts/zero-presentation-templates";

import { env } from "../../lib/env";
import type { ResolvedArtifactObject } from "./artifact-storage.service";
import { downloadS3BufferRange } from "../external/s3";

const HEADER_BYTES = 64 * 1024;
const ZIP_DIRECTORY_BYTES = 4 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04_03_4b_50;
const ZIP_CENTRAL_FILE_HEADER = 0x02_01_4b_50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

type PresentationTemplatePreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "unsupported_format"
        | "invalid_file"
        | "encrypted_file"
        | "too_large";
      readonly message: string;
    };

function failure(
  code: Exclude<
    PresentationTemplatePreflightResult,
    { readonly ok: true }
  >["code"],
  message: string,
): PresentationTemplatePreflightResult {
  return { ok: false, code, message };
}

function normalizedContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index === -1 ? "" : filename.slice(index).toLowerCase();
}

function includesEncryptedPackage(buffer: Buffer): boolean {
  return (
    buffer.includes(Buffer.from("EncryptedPackage", "ascii")) ||
    buffer.includes(Buffer.from("EncryptedPackage", "utf16le"))
  );
}

function findSignatureBackward(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

function validatePptxCentralDirectory(
  tail: Buffer,
  tailStart: number,
  objectSize: number,
): PresentationTemplatePreflightResult {
  const eocdOffset = findSignatureBackward(tail, ZIP_END_OF_CENTRAL_DIRECTORY);
  if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
    return failure("invalid_file", "The PowerPoint file is incomplete");
  }

  const directorySize = tail.readUInt32LE(eocdOffset + 12);
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
  const directoryEnd = directoryOffset + directorySize;
  if (
    directorySize > ZIP_DIRECTORY_BYTES ||
    directoryOffset < tailStart ||
    directoryEnd > objectSize
  ) {
    return failure("invalid_file", "The PowerPoint file directory is invalid");
  }

  const directoryStartInTail = directoryOffset - tailStart;
  const directoryEndInTail = directoryStartInTail + directorySize;
  if (directoryEndInTail > tail.length) {
    return failure(
      "invalid_file",
      "The PowerPoint file directory is incomplete",
    );
  }

  let offset = directoryStartInTail;
  let hasPresentation = false;
  while (offset < directoryEndInTail) {
    if (
      offset + 46 > directoryEndInTail ||
      tail.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER
    ) {
      return failure(
        "invalid_file",
        "The PowerPoint file directory is invalid",
      );
    }
    const flags = tail.readUInt16LE(offset + 8);
    const filenameLength = tail.readUInt16LE(offset + 28);
    const extraLength = tail.readUInt16LE(offset + 30);
    const commentLength = tail.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + filenameLength + extraLength + commentLength;
    if (entryEnd > directoryEndInTail) {
      return failure(
        "invalid_file",
        "The PowerPoint file directory is incomplete",
      );
    }
    const filename = tail
      .subarray(offset + 46, offset + 46 + filenameLength)
      .toString("utf8");
    if ((flags & 1) !== 0) {
      return failure(
        "encrypted_file",
        "Encrypted PowerPoint files are not supported",
      );
    }
    if (filename === "ppt/presentation.xml") {
      hasPresentation = true;
    }
    offset = entryEnd;
  }

  return hasPresentation
    ? { ok: true }
    : failure(
        "invalid_file",
        "The file is not a valid PowerPoint presentation",
      );
}

export const preflightPresentationTemplate$ = command(
  async (
    { get },
    args: { readonly source: ResolvedArtifactObject },
    signal: AbortSignal,
  ): Promise<PresentationTemplatePreflightResult> => {
    const { source } = args;
    if (source.size > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
      return failure(
        "too_large",
        `Presentation files must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`,
      );
    }
    if (source.size === 0) {
      return failure("invalid_file", "The uploaded presentation is empty");
    }

    const extension = extensionOf(source.filename);
    const contentType = normalizedContentType(source.contentType);
    if (extension !== ".pptx") {
      return failure(
        "unsupported_format",
        "Only .pptx presentation files are supported",
      );
    }

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const headEnd = Math.min(source.size, HEADER_BYTES) - 1;
    const tailStart = Math.max(0, source.size - ZIP_DIRECTORY_BYTES);
    const [head, tail] = await Promise.all([
      get(downloadS3BufferRange(bucket, source.key, 0, headEnd, signal)),
      get(
        downloadS3BufferRange(
          bucket,
          source.key,
          tailStart,
          source.size - 1,
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();

    const acceptedPptxTypes = new Set([
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
      "application/octet-stream",
    ]);
    if (!acceptedPptxTypes.has(contentType)) {
      return failure(
        "unsupported_format",
        "The uploaded file is not a .pptx file",
      );
    }
    const oleHeader = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    if (head.subarray(0, oleHeader.length).equals(oleHeader)) {
      return includesEncryptedPackage(Buffer.concat([head, tail]))
        ? failure(
            "encrypted_file",
            "Encrypted PowerPoint files are not supported",
          )
        : failure(
            "unsupported_format",
            "Legacy .ppt files are not supported; save the file as .pptx",
          );
    }
    if (head.length < 4 || head.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) {
      return failure("invalid_file", "The file is not a valid .pptx archive");
    }
    return validatePptxCentralDirectory(tail, tailStart, source.size);
  },
);
