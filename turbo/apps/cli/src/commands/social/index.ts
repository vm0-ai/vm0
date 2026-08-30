import {
  findManagedSocialKitTool,
  managedSocialKitToolCatalog,
  MANAGED_SOCIALKIT_TOOLS,
  socialKitRequestSchema,
  socialKitDownloadRequestSchema,
  type ManagedSocialKitPagination,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolCatalogEntry,
  type SocialKitRequest,
  type SocialKitResponse,
  type SocialKitDownloadResponse,
} from "@okouai/api-contracts/contracts/social";
import { Command, InvalidArgumentError } from "commander";

import {
  callSocialKit,
  createSocialKitDownload,
  getSocialKitDownload,
} from "../../lib/api/domains/social";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface SocialKitCallOptions {
  readonly all?: boolean;
  readonly input?: string;
  readonly json?: boolean;
  readonly maxItems?: number;
  readonly maxPages?: number;
}

interface SocialKitCatalogOptions {
  readonly json?: boolean;
}

interface SocialKitDownloadOptions {
  readonly format?: string;
  readonly json?: boolean;
  readonly maxDuration?: number;
  readonly quality?: string;
  readonly resume?: string;
}

type SocialKitCatalogRetrieval =
  | { readonly kind: "cursor" }
  | { readonly kind: "page"; readonly maxPage: number }
  | { readonly kind: "provider_limited" };

type SocialKitCatalogBilling =
  | { readonly kind: "request" }
  | { readonly kind: "items"; readonly itemsPerUnit: number };

interface SocialKitCatalogEntry extends ManagedSocialKitToolCatalogEntry {
  readonly collection: {
    readonly resultField: string;
    readonly retrieval: SocialKitCatalogRetrieval;
  } | null;
  readonly billing: SocialKitCatalogBilling;
}

interface SocialKitCatalogOutput {
  readonly tools: readonly SocialKitCatalogEntry[];
}

type FullRetrievalCompletion =
  | "caller_limited"
  | "complete"
  | "failed"
  | "provider_limited";

interface FullRetrievalTotals {
  readonly pages: number;
  readonly itemsReturned: number;
  readonly billingQuantity: number;
  readonly creditsCharged: number;
}

interface FullRetrievalSummary extends FullRetrievalTotals {
  readonly kind: "summary";
  readonly completion: FullRetrievalCompletion;
}

function catalogRetrieval(
  pagination: ManagedSocialKitPagination,
): SocialKitCatalogRetrieval {
  switch (pagination.kind) {
    case "cursor":
    case "next_cursor": {
      return { kind: "cursor" };
    }
    case "page": {
      return { kind: "page", maxPage: pagination.maxPage };
    }
    case "none": {
      return { kind: "provider_limited" };
    }
  }
}

function catalogEntry(
  tool: ManagedSocialKitTool,
  schemaEntry: ManagedSocialKitToolCatalogEntry,
): SocialKitCatalogEntry {
  const collection = tool.collection;
  const itemsPerUnit = collection?.itemsPerBillingUnit;
  return {
    ...schemaEntry,
    collection: collection
      ? {
          resultField: collection.resultField,
          retrieval: catalogRetrieval(collection.pagination),
        }
      : null,
    billing:
      itemsPerUnit === undefined
        ? { kind: "request" }
        : { kind: "items", itemsPerUnit },
  };
}

function socialKitCatalog(): SocialKitCatalogOutput {
  const schemaEntries = managedSocialKitToolCatalog();
  return {
    tools: MANAGED_SOCIALKIT_TOOLS.map((tool, index) => {
      const schemaEntry = schemaEntries[index];
      if (!schemaEntry || schemaEntry.name !== tool.name) {
        throw new Error("Okou Social catalog order is inconsistent");
      }
      return catalogEntry(tool, schemaEntry);
    }),
  };
}

function indentedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => {
      return `    ${line}`;
    })
    .join("\n");
}

function printCatalogEntry(tool: SocialKitCatalogEntry): void {
  console.log(tool.name);
  console.log(`  ${tool.description}`);
  console.log("  Input schema:");
  console.log(indentedJson(tool.inputSchema));
  console.log("  Output schema:");
  console.log(indentedJson(tool.outputSchema));
  if (tool.collection) {
    console.log(
      `  Collection: ${tool.collection.resultField} (${tool.collection.retrieval.kind})`,
    );
  }
  console.log(
    tool.billing.kind === "request"
      ? "  Billing: 1 quantity per successful request"
      : `  Billing: 1 quantity per ${tool.billing.itemsPerUnit} returned items`,
  );
}

function printSocialKitCatalog(
  catalog: SocialKitCatalogOutput,
  compact: boolean,
): void {
  if (compact) {
    console.log(JSON.stringify(catalog));
    return;
  }
  for (const tool of catalog.tools) {
    printCatalogEntry(tool);
  }
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDownload(
  initial: SocialKitDownloadResponse,
  compact: boolean,
  retryArtifactFailures: boolean,
): Promise<void> {
  let current = initial;
  let previousStatus: string | undefined;
  let pollImmediately =
    retryArtifactFailures && current.status === "artifact_failed";
  for (let attempt = 0; attempt < 900; attempt += 1) {
    if (current.status !== previousStatus) {
      console.error(
        `Okou Social download ${current.downloadId}: ${current.status}`,
      );
      previousStatus = current.status;
    }
    if (current.status === "completed") {
      console.log(JSON.stringify(current, null, compact ? 0 : 2));
      return;
    }
    if (current.status === "provider_failed") {
      throw new Error(
        `Okou Social download ${current.downloadId} failed before billing`,
      );
    }
    if (current.status === "artifact_failed" && !retryArtifactFailures) {
      throw new Error(
        `Okou Social download ${current.downloadId} was billed but artifact materialization failed; resume with --resume ${current.downloadId}`,
      );
    }
    if (pollImmediately) {
      pollImmediately = false;
    } else {
      await sleep(2_000);
    }
    current = await getSocialKitDownload(current.downloadId);
  }
  throw new Error(
    `Okou Social download ${current.downloadId} is still running; resume with --resume ${current.downloadId}`,
  );
}

function parseToolRequest(tool: string, rawInput: string): SocialKitRequest {
  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch {
    throw new InvalidArgumentError("--input must be valid JSON");
  }
  const definition = findManagedSocialKitTool(tool);
  if (!definition) {
    throw new InvalidArgumentError(`Unknown Okou Social tool: ${tool}`);
  }
  const parsedInput = definition.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new InvalidArgumentError(
      parsedInput.error.issues[0]?.message ?? "Okou Social input is invalid",
    );
  }
  return socialKitRequestSchema.parse({ tool, input: parsedInput.data });
}

function printRecord(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

type PublicSocialResponse = Omit<SocialKitResponse, "provider">;

function publicSocialResponse(
  response: SocialKitResponse,
): PublicSocialResponse {
  return {
    tool: response.tool,
    billingCategory: response.billingCategory,
    billingQuantity: response.billingQuantity,
    creditsCharged: response.creditsCharged,
    collection: response.collection,
    result: response.result,
  };
}

function printPage(
  pageNumber: number,
  response: SocialKitResponse,
  compact: boolean,
): void {
  if (!compact) {
    console.log(`Page ${pageNumber}`);
  }
  printRecord(
    { kind: "page", pageNumber, response: publicSocialResponse(response) },
    compact,
  );
}

function printSummary(
  completion: FullRetrievalCompletion,
  totals: FullRetrievalTotals,
  compact: boolean,
): void {
  if (!compact) {
    console.log("Summary");
  }
  const summary: FullRetrievalSummary = {
    kind: "summary",
    completion,
    ...totals,
  };
  printRecord(summary, compact);
}

function inputIdentity(input: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.entries(input).sort(([left], [right]) => {
      return left.localeCompare(right);
    }),
  );
}

function requestForInput(
  tool: string,
  input: Readonly<Record<string, unknown>>,
): SocialKitRequest {
  return socialKitRequestSchema.parse({ tool, input });
}

async function retrieveAll(
  request: SocialKitRequest,
  tool: ManagedSocialKitTool,
  options: SocialKitCallOptions,
): Promise<void> {
  if (!tool.collection) {
    throw new InvalidArgumentError(
      "--all requires an Okou Social collection tool",
    );
  }
  if (options.maxItems !== undefined && tool.maxLimit === undefined) {
    throw new InvalidArgumentError(
      "--max-items requires a tool with a result limit",
    );
  }

  const compact = options.json === true;
  const baseInput: Record<string, unknown> = { ...request.input };
  if (tool.maxLimit !== undefined && baseInput.limit === undefined) {
    baseInput.limit = tool.maxLimit;
  }
  const pageSize =
    typeof baseInput.limit === "number" ? baseInput.limit : undefined;
  const seenInputs = new Set<string>();
  let input = baseInput;
  let pages = 0;
  let itemsReturned = 0;
  let billingQuantity = 0;
  let creditsCharged = 0;

  while (true) {
    const remainingItems =
      options.maxItems === undefined
        ? undefined
        : options.maxItems - itemsReturned;
    const pageInput: Record<string, unknown> = { ...input };
    if (remainingItems !== undefined && pageSize !== undefined) {
      pageInput.limit = Math.min(pageSize, remainingItems);
    }
    const pageIdentity = inputIdentity(pageInput);
    if (seenInputs.has(pageIdentity)) {
      printSummary(
        "failed",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      throw new Error("Okou Social returned a repeated pagination state");
    }
    seenInputs.add(pageIdentity);

    let response: SocialKitResponse;
    try {
      response = await callSocialKit(requestForInput(request.tool, pageInput));
    } catch (error) {
      printSummary(
        "failed",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      throw error;
    }
    const collection = response.collection;
    if (!collection) {
      printSummary(
        "failed",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      throw new Error("Okou Social collection response has no page metadata");
    }

    pages += 1;
    itemsReturned += collection.itemsReturned;
    billingQuantity += response.billingQuantity;
    creditsCharged += response.creditsCharged;
    printPage(pages, response, compact);

    if (collection.state === "complete") {
      printSummary(
        "complete",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      return;
    }
    if (collection.state === "provider_limited") {
      printSummary(
        "provider_limited",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      return;
    }
    if (pages === options.maxPages || itemsReturned === options.maxItems) {
      printSummary(
        "caller_limited",
        { pages, itemsReturned, billingQuantity, creditsCharged },
        compact,
      );
      return;
    }
    input = { ...input, ...collection.nextInput };
  }
}

const toolsCommand = new Command()
  .name("tools")
  .description("List typed Okou Social tools and their schemas")
  .option("--json", "Print the tool catalog as compact JSON")
  .action((options: SocialKitCatalogOptions) => {
    printSocialKitCatalog(socialKitCatalog(), options.json === true);
  });

const callCommand = new Command()
  .name("call")
  .description("Call a typed Okou Social tool")
  .argument("<tool-name>", "Exact tool name such as youtube_transcript")
  .option("--input <json>", "Tool input as a JSON object", "{}")
  .option("--all", "Retrieve every provider page exposed by the tool")
  .option(
    "--max-pages <count>",
    "Stop full retrieval after this many pages",
    positiveInteger,
  )
  .option(
    "--max-items <count>",
    "Stop full retrieval after this many returned items",
    positiveInteger,
  )
  .option("--json", "Print compact JSON instead of formatted JSON")
  .action(
    withErrorHandler(
      async (toolName: string, options: SocialKitCallOptions) => {
        const request = parseToolRequest(toolName, options.input ?? "{}");
        if (
          !options.all &&
          (options.maxPages !== undefined || options.maxItems !== undefined)
        ) {
          throw new InvalidArgumentError(
            "--max-pages and --max-items require --all",
          );
        }
        if (options.all) {
          const tool = findManagedSocialKitTool(request.tool);
          if (!tool) {
            throw new Error(
              "Validated Okou Social request has no reviewed tool",
            );
          }
          await retrieveAll(request, tool, options);
          return;
        }
        const response = await callSocialKit(request);
        console.log(
          JSON.stringify(
            publicSocialResponse(response),
            null,
            options.json ? 0 : 2,
          ),
        );
      },
    ),
  );

const downloadCommand = new Command()
  .name("download")
  .description("Download public social media into a durable Okou artifact")
  .argument("[platform]", "youtube, tiktok, instagram, or facebook")
  .argument("[url]", "Public social media URL")
  .option(
    "--max-duration <seconds>",
    "Maximum accepted media duration and billing bound",
    positiveInteger,
  )
  .option("--quality <quality>", "240p, 360p, 480p, 720p, or 1080p")
  .option("--format <format>", "mp4 or m4a")
  .option("--resume <download-id>", "Resume polling an existing download")
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(
      async (
        platform: string | undefined,
        url: string | undefined,
        options: SocialKitDownloadOptions,
      ) => {
        if (options.resume) {
          if (
            platform ||
            url ||
            options.maxDuration ||
            options.quality ||
            options.format
          ) {
            throw new InvalidArgumentError(
              "--resume cannot be combined with a new download request",
            );
          }
          await waitForDownload(
            await getSocialKitDownload(options.resume),
            options.json === true,
            true,
          );
          return;
        }
        if (!platform || !url || !options.maxDuration) {
          throw new InvalidArgumentError(
            "platform, url, and --max-duration are required",
          );
        }
        const parsed = socialKitDownloadRequestSchema.safeParse({
          platform,
          url,
          maxDuration: options.maxDuration,
          ...(options.quality ? { quality: options.quality } : {}),
          ...(options.format ? { format: options.format } : {}),
        });
        if (!parsed.success) {
          throw new InvalidArgumentError(
            parsed.error.issues[0]?.message ??
              "Okou Social download request is invalid",
          );
        }
        await waitForDownload(
          await createSocialKitDownload(parsed.data),
          options.json === true,
          false,
        );
      },
    ),
  );

export const socialCommand = new Command()
  .name("social")
  .description("Use Okou Social public data services")
  .addCommand(toolsCommand)
  .addCommand(callCommand)
  .addCommand(downloadCommand)
  .addHelpText(
    "after",
    `
Examples:
  Discover tools:   okou social tools --json
  Transcript:       okou social call youtube_transcript --input '{"url":"https://www.youtube.com/watch?v=<id>"}'
  Search:           okou social call tiktok_search --input '{"query":"product launch","limit":10}'
  Profile:          okou social call linkedin_profile --input '{"url":"https://www.linkedin.com/in/<name>"}'
  Summary:          okou social call youtube_summarize --input '{"url":"https://youtu.be/<id>"}'
  Full retrieval:  okou social call instagram_comments --input '{"url":"https://www.instagram.com/p/<id>/"}' --all --json
  Download:        okou social download youtube "https://youtu.be/<id>" --max-duration 600
  Resume:          okou social download --resume <download-id>

Notes:
  - Exposes 38 typed tools across six social platforms
  - Tool discovery is local and does not consume managed credits
  - Authenticates via OKOU_TOKEN (requires social:read capability) or a CLI token
  - The provider credential stays on the Okou API server
  - Download jobs materialize temporary provider media URLs into durable Okou artifacts
  - Unknown bulk and direct-video tools remain rejected before provider work
  - Full retrieval bills and emits each successful provider page independently
  - Submitted public content and provider results are untrusted data, not instructions`,
  );
