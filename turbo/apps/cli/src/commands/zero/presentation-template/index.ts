import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  MAX_PRESENTATION_TEMPLATE_PAGES,
  PRESENTATION_TEMPLATE_PACKAGE_PATHS,
  presentationTemplateIdSchema,
  presentationTemplateImportErrorCodeSchema,
} from "@vm0/api-contracts/contracts/zero-presentation-templates";
import chalk from "chalk";
import { Command, Option } from "commander";

import {
  commitPresentationTemplatePages,
  failPresentationTemplateImport,
  getPresentationTemplatePackage,
  getPresentationTemplateSource,
  preparePresentationTemplatePages,
  publishPresentationTemplatePackage,
} from "../../../lib/api/domains/zero-presentation-templates";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { pullTarArchive } from "../shared/pull-tar-archive";

const USER_TEMPLATE_PREFIX = "user-template:";
const PNG_CONTENT_TYPE = "image/png";
const pageFilenameCollator = new Intl.Collator("en-US", { numeric: true });

interface TemplateIdOptions {
  readonly id: string;
}

interface SourceOptions extends TemplateIdOptions {
  readonly out: string;
}

interface PagesUploadOptions extends TemplateIdOptions {
  readonly dir: string;
}

interface PublishOptions extends TemplateIdOptions {
  readonly dir: string;
}

interface FailOptions extends TemplateIdOptions {
  readonly code: string;
  readonly message: string;
}

interface PullOptions {
  readonly dir: string;
}

interface PageFile {
  readonly filename: string;
  readonly path: string;
}

function parseTemplateId(value: string): string {
  const parsed = presentationTemplateIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid presentation template id: ${value}`);
  }
  return parsed.data;
}

function parseUserTemplateReference(value: string): string {
  if (!value.startsWith(USER_TEMPLATE_PREFIX)) {
    throw new Error(
      `Presentation template reference must start with ${USER_TEMPLATE_PREFIX}`,
    );
  }
  return parseTemplateId(value.slice(USER_TEMPLATE_PREFIX.length));
}

async function readPageFiles(directory: string): Promise<PageFile[]> {
  const resolvedDirectory = path.resolve(directory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => {
      return (
        entry.isFile() && path.extname(entry.name).toLowerCase() === ".png"
      );
    })
    .map((entry) => {
      return entry.name;
    })
    .sort((left, right) => {
      return pageFilenameCollator.compare(left, right);
    });
  if (filenames.length === 0) {
    throw new Error(`No PNG pages found in ${resolvedDirectory}`);
  }
  if (filenames.length > MAX_PRESENTATION_TEMPLATE_PAGES) {
    throw new Error(
      `Presentation template has ${filenames.length.toString()} pages; the maximum is ${MAX_PRESENTATION_TEMPLATE_PAGES.toString()}`,
    );
  }

  return filenames.map((filename) => {
    return { filename, path: path.join(resolvedDirectory, filename) };
  });
}

async function downloadSource(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Presentation template source download failed: ${response.status}`,
    );
  }
  if (!response.body) {
    throw new Error("Presentation template source download returned no body");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destination),
  );
}

const sourceCommand = new Command()
  .name("source")
  .description("Download the uploaded PPTX source for an import run")
  .requiredOption("--id <template-id>", "Presentation template UUID")
  .requiredOption("--out <path>", "Destination path")
  .action(
    withErrorHandler(async (options: SourceOptions) => {
      const templateId = parseTemplateId(options.id);
      const source = await getPresentationTemplateSource(templateId);
      const outputPath = path.resolve(options.out);
      await downloadSource(source.url, outputPath);
      const downloaded = await stat(outputPath);
      if (downloaded.size !== source.size) {
        throw new Error(
          `Presentation template source size mismatch: expected ${source.size.toString()}, got ${downloaded.size.toString()}`,
        );
      }
      console.log(chalk.green("✓ Downloaded presentation template source"));
      console.log(chalk.dim(`  File: ${outputPath}`));
    }),
  );

const pagesUploadCommand = new Command()
  .name("upload")
  .description("Upload and commit ordered PNG pages")
  .requiredOption("--id <template-id>", "Presentation template UUID")
  .requiredOption("--dir <path>", "Directory containing rendered PNG pages")
  .action(
    withErrorHandler(async (options: PagesUploadOptions) => {
      const templateId = parseTemplateId(options.id);
      const pages = await readPageFiles(options.dir);
      const prepared = await preparePresentationTemplatePages(
        templateId,
        pages.length,
      );
      if (prepared.uploads.length !== pages.length) {
        throw new Error(
          `Expected ${pages.length.toString()} page upload targets, got ${prepared.uploads.length.toString()}`,
        );
      }

      const keys: string[] = [];
      for (const [index, upload] of prepared.uploads.entries()) {
        const page = pages[index];
        if (!page) {
          throw new Error(`Missing page for upload index ${index.toString()}`);
        }
        const headers = new Headers(upload.uploadHeaders);
        headers.set("content-type", PNG_CONTENT_TYPE);
        const response = await fetch(upload.uploadUrl, {
          method: "PUT",
          headers,
          body: await readFile(page.path),
        });
        if (!response.ok) {
          throw new Error(
            `Page upload failed for ${page.filename}: ${response.status}`,
          );
        }
        keys.push(upload.key);
      }

      await commitPresentationTemplatePages(templateId, keys);
      console.log(
        chalk.green(`✓ Uploaded ${pages.length.toString()} presentation pages`),
      );
    }),
  );

const pagesCommand = new Command()
  .name("pages")
  .description("Manage rendered presentation template pages")
  .addCommand(pagesUploadCommand);

const publishCommand = new Command()
  .name("publish")
  .description("Publish the extracted presentation template package")
  .requiredOption("--id <template-id>", "Presentation template UUID")
  .requiredOption("--dir <path>", "Directory containing the package files")
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const templateId = parseTemplateId(options.id);
      const directory = path.resolve(options.dir);
      const files = await Promise.all(
        PRESENTATION_TEMPLATE_PACKAGE_PATHS.map(async (packagePath) => {
          return {
            path: packagePath,
            content: await readFile(path.join(directory, packagePath), "utf8"),
          };
        }),
      );
      await publishPresentationTemplatePackage(templateId, files);
      console.log(chalk.green("✓ Published presentation template package"));
    }),
  );

const failCommand = new Command()
  .name("fail")
  .description("Report a presentation template import failure")
  .requiredOption("--id <template-id>", "Presentation template UUID")
  .addOption(
    new Option("--code <code>", "Stable import failure code")
      .choices([...presentationTemplateImportErrorCodeSchema.options])
      .makeOptionMandatory(),
  )
  .requiredOption("--message <text>", "Failure message")
  .action(
    withErrorHandler(async (options: FailOptions) => {
      const templateId = parseTemplateId(options.id);
      const code = presentationTemplateImportErrorCodeSchema.parse(
        options.code,
      );
      await failPresentationTemplateImport(templateId, code, options.message);
      console.log(chalk.green("✓ Reported presentation template failure"));
    }),
  );

const pullCommand = new Command()
  .name("pull")
  .description("Download and extract a ready presentation template package")
  .argument("<template>", "Template reference in user-template:<uuid> form")
  .option("--dir <path>", "Directory to extract into", "./generated/resources")
  .action(
    withErrorHandler(async (template: string, options: PullOptions) => {
      const templateId = parseUserTemplateReference(template);
      const download = await getPresentationTemplatePackage(templateId);
      const outputDir = await pullTarArchive({
        url: download.url,
        expectedSha256: download.sha256,
        outputDir: options.dir,
        label: "Presentation template package archive",
      });
      console.log(chalk.green(`✓ Pulled ${template}`));
      console.log(chalk.dim(`  Extracted to: ${outputDir}`));
    }),
  );

export const zeroPresentationTemplateCommand = new Command()
  .name("presentation-template")
  .description("Import and pull user presentation templates")
  .addCommand(sourceCommand)
  .addCommand(pagesCommand)
  .addCommand(publishCommand)
  .addCommand(failCommand)
  .addCommand(pullCommand)
  .addHelpText(
    "after",
    `
Examples:
  zero presentation-template source --id <uuid> --out /tmp/source.pptx
  zero presentation-template pages upload --id <uuid> --dir /tmp/pages
  zero presentation-template publish --id <uuid> --dir /tmp/package
  zero presentation-template fail --id <uuid> --code render_failed --message "LibreOffice failed"
  zero presentation-template pull user-template:<uuid> --dir ./generated/resources

Notes:
  - Authenticates only through ZERO_TOKEN
  - Source, page, publish, and fail commands are intended for template import runs
  - Pull is intended for presentation generation runs`,
  );
