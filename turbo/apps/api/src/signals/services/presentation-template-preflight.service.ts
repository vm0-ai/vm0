import { command } from "ccstate";
import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES,
  PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { downloadS3BufferRange } from "../external/s3";

const HEADER_BYTES = 64 * 1024;
const ZIP_DIRECTORY_BYTES = 4 * 1024 * 1024;
const ZIP_LOCAL_FILE_HEADER = 0x04_03_4b_50;
const ZIP_CENTRAL_FILE_HEADER = 0x02_01_4b_50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

type PresentationTemplatePreflightResult =
  | { readonly ok: true; readonly slideCount: number }
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
    { readonly ok: true; readonly slideCount: number }
  >["code"],
  message: string,
): PresentationTemplatePreflightResult {
  return { ok: false, code, message };
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
  let hasMacros = false;
  const slides = new Set<string>();
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
    if (/^ppt\/slides\/slide\d+\.xml$/u.test(filename)) {
      slides.add(filename);
    }
    if (filename === "ppt/vbaProject.bin") {
      hasMacros = true;
    }
    offset = entryEnd;
  }

  if (!hasPresentation || slides.size === 0) {
    return failure(
      "invalid_file",
      "The file is not a valid PowerPoint presentation",
    );
  }
  if (hasMacros) {
    return failure(
      "unsupported_format",
      "Macro-enabled PowerPoint files are not supported",
    );
  }
  if (slides.size > MAX_PRESENTATION_TEMPLATE_PAGES) {
    return failure(
      "invalid_file",
      `PowerPoint files must contain ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()} slides or fewer`,
    );
  }
  return { ok: true, slideCount: slides.size };
}

export const preflightPresentationTemplate$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
    },
    signal: AbortSignal,
  ): Promise<PresentationTemplatePreflightResult> => {
    if (args.size > MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES) {
      return failure(
        "too_large",
        `Presentation files must be ${MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES.toString()} bytes or smaller`,
      );
    }
    if (args.size === 0) {
      return failure("invalid_file", "The uploaded presentation is empty");
    }
    if (extensionOf(args.filename) !== ".pptx") {
      return failure(
        "unsupported_format",
        "Only .pptx presentation files are supported",
      );
    }
    if (args.contentType !== PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPE) {
      return failure(
        "unsupported_format",
        "The uploaded file is not a .pptx file",
      );
    }

    const headEnd = Math.min(args.size, HEADER_BYTES) - 1;
    const tailStart = Math.max(0, args.size - ZIP_DIRECTORY_BYTES);
    const [head, tail] = await Promise.all([
      get(downloadS3BufferRange(args.bucket, args.key, 0, headEnd, signal)),
      get(
        downloadS3BufferRange(
          args.bucket,
          args.key,
          tailStart,
          args.size - 1,
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();

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
    return validatePptxCentralDirectory(tail, tailStart, args.size);
  },
);
