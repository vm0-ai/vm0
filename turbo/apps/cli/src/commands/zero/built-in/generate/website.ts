import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebWebsite } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { publishStaticSite } from "../../../../lib/host/publish-static-site";
import { buildGeneratedWebsite } from "../../shared/website-build";

const WEBSITE_TEMPLATES = ["auto", "launch", "profile"] as const;

interface WebsiteOptions {
  readonly prompt?: string;
  readonly template: string;
  readonly site?: string;
  readonly title?: string;
  readonly audience?: string;
  readonly keepBuildDir?: boolean;
  readonly json?: boolean;
}

function parseTemplate(value: string): string {
  if (
    WEBSITE_TEMPLATES.some((template) => {
      return template === value;
    })
  ) {
    return value;
  }
  throw new InvalidArgumentError("template must be auto, launch, or profile");
}

function readPrompt(options: WebsiteOptions): string {
  if (options.prompt?.trim()) {
    return options.prompt.trim();
  }

  if (process.stdin.isTTY === false) {
    const prompt = readFileSync("/dev/stdin", "utf8").trim();
    if (prompt.length > 0) {
      return prompt;
    }
  }

  throw new Error("--prompt is required", {
    cause: new Error(
      'Usage: zero built-in generate website --prompt "A launch site for a developer tool"',
    ),
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const websiteCommand = new Command()
  .name("website")
  .description("Generate, build, and publish a hosted website from a prompt")
  .option("--prompt <text>", "Website prompt; can also be piped via stdin")
  .option(
    "--template <template>",
    "Template: auto, launch, or profile",
    parseTemplate,
    "auto",
  )
  .option("--site <slug>", "Hosted site slug; defaults to the generated name")
  .option("--title <text>", "Requested site title or name")
  .option("--audience <text>", "Audience context")
  .option("--keep-build-dir", "Keep the temporary static build directory")
  .option("--json", "Print metadata as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Generate site:         zero built-in generate website --prompt "A launch site for a developer observability tool"
  Pick template:         zero built-in generate website --template profile --prompt "Portfolio for a robotics photographer"
  Stable hosted slug:    zero built-in generate website --site api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | zero built-in generate website

Output:
  Builds a React template into a static website, publishes it with zero host, and prints the hosted URL

Notes:
  - Authenticates via ZERO_TOKEN (requires host:write capability)
  - Charges org credits for model-generated website content
  - Uses OpenAI gpt-5.5 through the Responses API`,
  )
  .action(
    withErrorHandler(async (options: WebsiteOptions) => {
      const prompt = readPrompt(options);
      if (!options.json) {
        console.log(chalk.dim("Generating website content..."));
      }
      const generation = await generateWebWebsite({
        prompt,
        template: options.template,
        title: options.title,
        audience: options.audience,
      });

      const buildRoot = await mkdtemp(join(tmpdir(), "zero-website-"));
      const outDir = join(buildRoot, "dist");
      try {
        if (!options.json) {
          console.log(chalk.dim("Building React template..."));
        }
        await buildGeneratedWebsite({
          outDir,
          templateId: generation.templateId,
          siteData: generation.siteData,
        });

        const site = options.site ?? generation.slugSuggestion;
        const hosted = await publishStaticSite({
          dir: outDir,
          site,
          onProgress: options.json
            ? undefined
            : (progress) => {
                if (progress.phase === "preparing") {
                  console.log(
                    chalk.dim(`Preparing ${progress.fileCount} files...`),
                  );
                  return;
                }
                console.log(chalk.dim(`Uploading ${progress.path}`));
              },
        });

        const result = {
          url: hosted.url,
          siteId: hosted.siteId,
          deploymentId: hosted.deploymentId,
          publicSlug: hosted.publicSlug,
          site,
          templateId: generation.templateId,
          templateLabel: generation.templateLabel,
          fileCount: hosted.fileCount,
          size: hosted.size,
          creditsCharged: generation.creditsCharged,
          model: generation.model,
          responseId: generation.responseId,
          generationId: generation.generationId,
          usage: generation.usage,
          ...(options.keepBuildDir ? { buildDir: outDir } : {}),
        };

        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green(`✓ Website generated: ${hosted.url}`));
        console.log(chalk.dim(`  Site: ${hosted.publicSlug}`));
        console.log(chalk.dim(`  Deployment: ${hosted.deploymentId}`));
        console.log(chalk.dim(`  Template: ${generation.templateLabel}`));
        console.log(chalk.dim(`  Files: ${hosted.fileCount.toLocaleString()}`));
        console.log(chalk.dim(`  Size: ${formatBytes(hosted.size)}`));
        console.log(
          chalk.dim(`  Credits charged: ${generation.creditsCharged}`),
        );
        console.log(chalk.dim(`  Model: ${generation.model}`));
        if (options.keepBuildDir) {
          console.log(chalk.dim(`  Build dir: ${outDir}`));
        }
      } finally {
        if (!options.keepBuildDir) {
          await rm(buildRoot, { recursive: true, force: true });
        }
      }
    }),
  );
