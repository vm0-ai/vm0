import { command } from "ccstate";

import { downloadS3BufferRange } from "../external/s3";

const ZIP_DIRECTORY_BYTES = 4 * 1024 * 1024;
const ZIP_CENTRAL_FILE_HEADER = 0x02_01_4b_50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const CENTRAL_FILE_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;

type PresentationTemplateSlideCountResult =
  | { readonly ok: true; readonly slideCount: number }
  | { readonly ok: false; readonly message: string };

function unreadable(): PresentationTemplateSlideCountResult {
  return {
    ok: false,
    message: "The uploaded presentation could not be read as a .pptx archive",
  };
}

function findSignatureBackward(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

/**
 * Count `ppt/slides/slideN.xml` entries in the ZIP central directory.
 *
 * The browser already rendered the deck, so the archive is known to open. The
 * one thing rendering cannot establish is that the committed page images came
 * from the committed PPTX, because the two are separate uploads tied together
 * only by the caller. A slide count read from the archive itself is the only
 * independent source for that.
 */
function countSlidesInCentralDirectory(
  tail: Buffer,
  tailStart: number,
  objectSize: number,
): PresentationTemplateSlideCountResult {
  const eocdOffset = findSignatureBackward(tail, ZIP_END_OF_CENTRAL_DIRECTORY);
  if (
    eocdOffset < 0 ||
    eocdOffset + END_OF_CENTRAL_DIRECTORY_BYTES > tail.length
  ) {
    return unreadable();
  }

  const directorySize = tail.readUInt32LE(eocdOffset + 12);
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (
    directorySize > ZIP_DIRECTORY_BYTES ||
    directoryOffset < tailStart ||
    directoryOffset + directorySize > objectSize
  ) {
    return unreadable();
  }

  const directoryStartInTail = directoryOffset - tailStart;
  const directoryEndInTail = directoryStartInTail + directorySize;
  if (directoryEndInTail > tail.length) {
    return unreadable();
  }

  let offset = directoryStartInTail;
  const slides = new Set<string>();
  while (offset < directoryEndInTail) {
    if (
      offset + CENTRAL_FILE_HEADER_BYTES > directoryEndInTail ||
      tail.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER
    ) {
      return unreadable();
    }
    const filenameLength = tail.readUInt16LE(offset + 28);
    const extraLength = tail.readUInt16LE(offset + 30);
    const commentLength = tail.readUInt16LE(offset + 32);
    const entryEnd =
      offset +
      CENTRAL_FILE_HEADER_BYTES +
      filenameLength +
      extraLength +
      commentLength;
    if (entryEnd > directoryEndInTail) {
      return unreadable();
    }
    const filename = tail
      .subarray(
        offset + CENTRAL_FILE_HEADER_BYTES,
        offset + CENTRAL_FILE_HEADER_BYTES + filenameLength,
      )
      .toString("utf8");
    if (/^ppt\/slides\/slide\d+\.xml$/u.test(filename)) {
      slides.add(filename);
    }
    offset = entryEnd;
  }

  return slides.size === 0
    ? unreadable()
    : { ok: true, slideCount: slides.size };
}

export const countPresentationTemplateSlides$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly size: number;
    },
    signal: AbortSignal,
  ): Promise<PresentationTemplateSlideCountResult> => {
    // The directory lives at the end of the archive, so one tail range is
    // enough. The whole file is never downloaded.
    const tailStart = Math.max(0, args.size - ZIP_DIRECTORY_BYTES);
    const tail = await get(
      downloadS3BufferRange(
        args.bucket,
        args.key,
        tailStart,
        args.size - 1,
        signal,
      ),
    );
    signal.throwIfAborted();
    return countSlidesInCentralDirectory(tail, tailStart, args.size);
  },
);
