import { Command } from "commander";

import {
  failPresentationTemplateImport,
  pullPresentationTemplatePages,
  pullPresentationTemplateSource,
} from "../../lib/api/domains/presentation-templates";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface SourcePullOptions {
  readonly id: string;
  readonly out: string;
}

interface PagesPullOptions {
  readonly id: string;
  readonly dir: string;
}

interface FailOptions {
  readonly id: string;
  readonly message: string;
}

const sourcePullCommand = new Command()
  .name("pull")
  .description("Download the committed source PPTX for a template import")
  .requiredOption("--id <templateId>", "Template import id")
  .requiredOption("--out <path>", "Destination file path")
  .action(
    withErrorHandler(async (options: SourcePullOptions) => {
      const result = await pullPresentationTemplateSource(
        options.id,
        options.out,
      );
      console.log(`Downloaded ${result.filename} to ${result.path}`);
    }),
  );

const sourceCommand = new Command()
  .name("source")
  .description("Work with a template import's committed source deck")
  .addCommand(sourcePullCommand);

const pagesPullCommand = new Command()
  .name("pull")
  .description(
    "Download the committed page images in authoritative page order. The set is written atomically: nothing lands in the directory unless every page downloads.",
  )
  .requiredOption("--id <templateId>", "Template import id")
  .requiredOption("--dir <path>", "Destination directory")
  .action(
    withErrorHandler(async (options: PagesPullOptions) => {
      const written = await pullPresentationTemplatePages(
        options.id,
        options.dir,
      );
      console.log(
        `Downloaded ${written.length.toString()} pages to ${options.dir}`,
      );
    }),
  );

const pagesCommand = new Command()
  .name("pages")
  .description("Work with a template import's committed page images")
  .addCommand(pagesPullCommand);

const failCommand = new Command()
  .name("fail")
  .description("Report a terminal template analysis failure")
  .requiredOption("--id <templateId>", "Template import id")
  .requiredOption("--message <text>", "Human-readable failure reason")
  .action(
    withErrorHandler(async (options: FailOptions) => {
      const result = await failPresentationTemplateImport(options.id, {
        code: "analysis_failed",
        message: options.message,
      });
      console.log(JSON.stringify(result));
    }),
  );

export const presentationTemplateCommand = new Command()
  .name("presentation-template")
  .description("Read a template import's committed inputs and report failures")
  .addCommand(sourceCommand)
  .addCommand(pagesCommand)
  .addCommand(failCommand);
