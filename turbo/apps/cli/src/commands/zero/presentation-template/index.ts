import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PAGES,
  presentationTemplateImportErrorCodeSchema,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { Command, InvalidArgumentError } from "commander";

import { ApiRequestError } from "../../../lib/api/core/client-factory";
import {
  commitPresentationTemplatePages,
  downloadPresentationTemplateSource,
  failPresentationTemplateImport,
  preparePresentationTemplatePages,
  publishPresentationTemplatePackage,
  uploadPresentationTemplatePage,
  type FailPresentationTemplateImportBody,
} from "../../../lib/api/domains/zero-presentation-templates";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PACKAGE_PATHS = [
  "DESIGN_SYSTEM.md",
  "LAYOUTS.md",
  "tokens.json",
] as const;

interface TemplateIdOptions {
  readonly id: string;
}

interface SourceOptions extends TemplateIdOptions {
  readonly out: string;
}

interface DirectoryOptions extends TemplateIdOptions {
  readonly dir: string;
}

interface FailureOptions extends TemplateIdOptions {
  readonly code: FailPresentationTemplateImportBody["code"];
  readonly message: string;
}

interface NumberedPage {
  readonly number: number;
  readonly path: string;
}

interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

function badRequest(message: string): ApiRequestError {
  return new ApiRequestError(message, "BAD_REQUEST", 400);
}

async function readPngDimensions(path: string): Promise<PngDimensions> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
      header.readUInt32BE(8) !== 13 ||
      header.toString("ascii", 12, 16) !== "IHDR"
    ) {
      throw badRequest(`Not a valid PNG page: ${path}`);
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width === 0 || height === 0) {
      throw badRequest(`PNG page has invalid dimensions: ${path}`);
    }
    return { width, height };
  } finally {
    await file.close();
  }
}

async function orderedPageFiles(dir: string): Promise<readonly NumberedPage[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const pages: NumberedPage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
      continue;
    }
    const match = /^page-(\d+)\.png$/iu.exec(entry.name);
    if (!match?.[1]) {
      throw badRequest(`Unexpected PNG page filename: ${entry.name}`);
    }
    pages.push({
      number: Number.parseInt(match[1], 10),
      path: join(dir, entry.name),
    });
  }
  pages.sort((left, right) => {
    return left.number - right.number;
  });
  if (pages.length === 0) {
    throw badRequest(`No page-<number>.png files found in ${dir}`);
  }
  if (pages.length > MAX_PRESENTATION_TEMPLATE_PAGES) {
    throw badRequest(
      `Presentation templates support at most ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()} pages`,
    );
  }
  for (const [index, page] of pages.entries()) {
    if (page.number !== index + 1) {
      throw badRequest("PNG page numbers must be unique and contiguous from 1");
    }
  }
  return pages;
}

async function sharedPageAspectRatio(
  pages: readonly NumberedPage[],
): Promise<number> {
  let first: PngDimensions | undefined;
  for (const page of pages) {
    const dimensions = await readPngDimensions(page.path);
    if (!first) {
      first = dimensions;
      continue;
    }
    if (
      BigInt(dimensions.width) * BigInt(first.height) !==
      BigInt(first.width) * BigInt(dimensions.height)
    ) {
      throw badRequest("All PNG pages must have the same aspect ratio");
    }
  }
  if (!first) {
    throw badRequest("At least one PNG page is required");
  }
  return first.width / first.height;
}

async function readPackageFile(
  dir: string,
  path: (typeof PACKAGE_PATHS)[number],
): Promise<{ readonly path: typeof path; readonly content: string }> {
  const localPath = join(dir, path);
  const details = await stat(localPath);
  if (!details.isFile()) {
    throw badRequest(`Not a regular package file: ${localPath}`);
  }
  const bytes = await readFile(localPath);
  if (bytes.byteLength > MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES) {
    throw badRequest(
      `${path} must be ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES.toString()} UTF-8 bytes or smaller`,
    );
  }
  try {
    return {
      path,
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw badRequest(`${path} must contain valid UTF-8 text`);
  }
}

function parseFailureCode(
  value: string,
): FailPresentationTemplateImportBody["code"] {
  const parsed = presentationTemplateImportErrorCodeSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `code must be one of: ${presentationTemplateImportErrorCodeSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

const sourceCommand = new Command()
  .name("source")
  .description("Download the source for this template import run")
  .requiredOption("--id <template-id>", "Presentation template ID")
  .requiredOption("--out <path>", "Destination file path")
  .action(
    withErrorHandler(async (options: SourceOptions) => {
      await downloadPresentationTemplateSource(options.id, options.out);
      console.log(`Downloaded presentation template source to ${options.out}`);
    }),
  );

const uploadPagesCommand = new Command()
  .name("upload")
  .description("Upload and commit rendered PNG pages")
  .requiredOption("--id <template-id>", "Presentation template ID")
  .requiredOption("--dir <path>", "Directory containing page-<number>.png")
  .action(
    withErrorHandler(async (options: DirectoryOptions) => {
      const pages = await orderedPageFiles(options.dir);
      const aspectRatio = await sharedPageAspectRatio(pages);
      const prepared = await preparePresentationTemplatePages(
        options.id,
        pages.length,
      );
      if (prepared.uploads.length !== pages.length) {
        throw new ApiRequestError(
          "Page upload preparation returned an unexpected number of URLs",
          "INVALID_RESPONSE",
          502,
        );
      }
      for (const [index, page] of pages.entries()) {
        const upload = prepared.uploads[index];
        if (!upload) {
          throw new ApiRequestError(
            "Page upload preparation omitted an upload URL",
            "INVALID_RESPONSE",
            502,
          );
        }
        await uploadPresentationTemplatePage(
          upload,
          new Uint8Array(await readFile(page.path)),
        );
      }
      await commitPresentationTemplatePages(options.id, {
        keys: prepared.uploads.map((upload) => {
          return upload.key;
        }),
        aspectRatio,
      });
      console.log(`Uploaded ${pages.length.toString()} presentation pages`);
    }),
  );

const pagesCommand = new Command()
  .name("pages")
  .description("Manage rendered pages for this template import run")
  .addCommand(uploadPagesCommand);

const publishCommand = new Command()
  .name("publish")
  .description("Publish the generated presentation template package")
  .requiredOption("--id <template-id>", "Presentation template ID")
  .requiredOption("--dir <path>", "Directory containing the package files")
  .action(
    withErrorHandler(async (options: DirectoryOptions) => {
      const files = await Promise.all(
        PACKAGE_PATHS.map(async (path) => {
          return await readPackageFile(options.dir, path);
        }),
      );
      await publishPresentationTemplatePackage(options.id, { files });
      console.log("Published presentation template package");
    }),
  );

const failCommand = new Command()
  .name("fail")
  .description("Report a terminal presentation template import failure")
  .requiredOption("--id <template-id>", "Presentation template ID")
  .requiredOption("--code <code>", "Failure code", parseFailureCode)
  .requiredOption("--message <message>", "Failure message")
  .action(
    withErrorHandler(async (options: FailureOptions) => {
      const message = options.message.trim();
      if (!message) {
        throw new InvalidArgumentError("message must not be empty");
      }
      await failPresentationTemplateImport(options.id, {
        code: options.code,
        message,
      });
      console.log("Reported presentation template import failure");
    }),
  );

export const zeroPresentationTemplateCommand = new Command()
  .name("presentation-template")
  .description("Run-scoped presentation template import I/O")
  .addCommand(sourceCommand)
  .addCommand(pagesCommand)
  .addCommand(publishCommand)
  .addCommand(failCommand);
