import { setTimeout as sleep } from "node:timers/promises";

import {
  findManagedSocialKitTool,
  managedSocialKitToolCatalog,
  MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES,
  socialKitRequestSchema,
  socialKitDownloadRequestSchema,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolCatalogEntry,
  type SocialKitCollectionUncertainty,
  type SocialKitCollectionProviderLimitedReason,
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

type DownloadSignal = "SIGINT" | "SIGTERM";

const DOWNLOAD_SIGNAL_EXIT_CODE: Readonly<Record<DownloadSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

interface SocialKitCatalogOutput {
  readonly tools: readonly ManagedSocialKitToolCatalogEntry[];
  readonly unsupportedCapabilities: typeof MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES;
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
  readonly providerLimitedReason?: SocialKitCollectionProviderLimitedReason;
  readonly uncertaintyReason?: SocialKitCollectionUncertainty["reason"];
  readonly reportedTotal?: number;
}

interface FullRetrievalSummary extends FullRetrievalTotals {
  readonly kind: "summary";
  readonly completion: FullRetrievalCompletion;
}

function socialKitCatalog(): SocialKitCatalogOutput {
  return {
    tools: managedSocialKitToolCatalog(),
    unsupportedCapabilities: MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES,
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

function printCatalogEntry(tool: ManagedSocialKitToolCatalogEntry): void {
  console.log(tool.name);
  console.log(`  ${tool.description}`);
  console.log("  Input schema:");
  console.log(indentedJson(tool.inputSchema));
  console.log("  Output schema:");
  console.log(indentedJson(tool.outputSchema));
  if (tool.availability === "transcript") {
    console.log(
      "  Availability: transcript (provider evidence required; unknown remains explicit)",
    );
  }
  if (tool.collection) {
    console.log(
      `  Collection: ${tool.collection.resultField} (${tool.collection.retrieval.kind})`,
    );
    if (tool.collection.reportedTotalField) {
      console.log(`  Reported total: ${tool.collection.reportedTotalField}`);
    }
    if (tool.collection.defaultLimit !== undefined) {
      console.log(`  Default page limit: ${tool.collection.defaultLimit}`);
    }
    if (tool.collection.requestMaxLimit !== undefined) {
      console.log(
        `  Accepted request maximum: ${tool.collection.requestMaxLimit}`,
      );
    }
    if (tool.collection.effectiveLimit !== undefined) {
      console.log(
        `  Effective request limit: ${tool.collection.effectiveLimit}`,
      );
    }
    if (tool.collection.pageSize) {
      console.log(
        "  Page size: provider-controlled and may differ from the request limit",
      );
    }
    if (tool.collection.itemContract) {
      console.log(`  Item contract: ${tool.collection.itemContract}`);
    }
    if (tool.collection.emptyResult) {
      console.log(
        "  Empty result: unreliable; returns provider_limited uncertainty, bills the successful request once, and is not retried",
      );
    }
    if (tool.collection.providerLimit) {
      const limit = tool.collection.providerLimit;
      console.log(
        limit.kind === "no_pagination"
          ? "  Provider limit: no pagination"
          : `  Provider limit: max page ${limit.maxPage}`,
      );
    }
  }
  console.log(
    tool.billing.kind === "request"
      ? "  Billing: 1 quantity per successful request"
      : tool.billing.quantityBasis === "effective_request_limit"
        ? `  Billing: 1 quantity per ${tool.billing.itemsPerUnit} items in the effective request limit`
        : `  Billing: 1 quantity per ${tool.billing.itemsPerUnit} returned items`,
  );
}

function printUnsupportedCapabilities(): void {
  console.log("Unsupported capabilities");
  for (const capability of MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES) {
    console.log(`  ${capability.platform}.${capability.capability}`);
    console.log(`    ${capability.guidance}`);
  }
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
  printUnsupportedCapabilities();
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function resumeDownloadCommand(downloadId: string): string {
  return `okou social download --resume ${downloadId}`;
}

function terminalDownloadError(response: SocialKitDownloadResponse): Error {
  if (!response.error) {
    return new Error(
      `Okou Social download ${response.downloadId} returned ${response.status} without error details`,
    );
  }
  const lines = [
    "Okou Social download failed",
    `  Download ID: ${response.downloadId}`,
    `  Status: ${response.status}`,
    `  Platform: ${response.platform}`,
    `  Requested quality: ${response.quality}`,
    `  Requested format: ${response.format}`,
    `  Error code: ${response.error.code}`,
    `  Error: ${response.error.message}`,
    `  Retryable: ${response.error.retryable ? "yes" : "no"}`,
    `  Billed: ${response.error.billed ? "yes" : "no"}`,
  ];
  if (response.status === "artifact_failed") {
    lines.push(`  Resume: ${resumeDownloadCommand(response.downloadId)}`);
  }
  return new Error(lines.join("\n"));
}

function failDownload(
  response: SocialKitDownloadResponse,
  compact: boolean,
): never {
  if (compact) {
    console.log(JSON.stringify(response));
  }
  throw terminalDownloadError(response);
}

async function withDownloadInterruption(
  downloadId: string,
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let interruption: DownloadSignal | undefined;
  const interrupt = (signal: DownloadSignal): void => {
    if (interruption) {
      return;
    }
    interruption = signal;
    console.error(
      `Okou Social download ${downloadId} continues on the server after ${signal}`,
    );
    console.error(`Resume: ${resumeDownloadCommand(downloadId)}`);
    process.exitCode = DOWNLOAD_SIGNAL_EXIT_CODE[signal];
    controller.abort();
  };
  const onSigint = (): void => {
    interrupt("SIGINT");
  };
  const onSigterm = (): void => {
    interrupt("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await action(controller.signal);
  } catch (error) {
    if (!interruption) {
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

async function waitForDownload(
  initial: SocialKitDownloadResponse,
  compact: boolean,
  retryArtifactFailures: boolean,
  signal: AbortSignal,
): Promise<void> {
  let current = initial;
  let previousStatus: string | undefined;
  let pollImmediately =
    retryArtifactFailures && current.status === "artifact_failed";
  for (let attempt = 0; attempt < 900; attempt += 1) {
    signal.throwIfAborted();
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
      failDownload(current, compact);
    }
    if (current.status === "artifact_failed" && !retryArtifactFailures) {
      failDownload(current, compact);
    }
    if (pollImmediately) {
      pollImmediately = false;
    } else {
      await sleep(2_000, undefined, { signal });
    }
    current = await getSocialKitDownload(current.downloadId, signal);
  }
  signal.throwIfAborted();
  throw new Error(
    `Okou Social download ${current.downloadId} is still running; resume with: ${resumeDownloadCommand(current.downloadId)}`,
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

function printPage(
  pageNumber: number,
  response: SocialKitResponse,
  compact: boolean,
): void {
  if (!compact) {
    console.log(`Page ${pageNumber}`);
  }
  printRecord({ kind: "page", pageNumber, response }, compact);
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

function collectionSummaryEvidence(
  collection: NonNullable<SocialKitResponse["collection"]>,
): Pick<
  FullRetrievalTotals,
  "providerLimitedReason" | "reportedTotal" | "uncertaintyReason"
> {
  const reason =
    collection.state === "provider_limited" ? collection.reason : undefined;
  const uncertaintyReason =
    collection.state === "provider_limited"
      ? collection.uncertainty?.reason
      : undefined;
  return {
    ...(reason ? { providerLimitedReason: reason } : {}),
    ...(uncertaintyReason ? { uncertaintyReason } : {}),
    ...(collection.reportedTotal !== undefined
      ? { reportedTotal: collection.reportedTotal }
      : {}),
  };
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

function reachedCallerRetrievalLimit(
  pages: number,
  itemsReturned: number,
  options: SocialKitCallOptions,
): boolean {
  return (
    pages === options.maxPages ||
    (options.maxItems !== undefined && itemsReturned >= options.maxItems)
  );
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
  if (tool.collection.effectiveLimit !== undefined) {
    baseInput.limit =
      typeof baseInput.limit === "number"
        ? Math.min(baseInput.limit, tool.collection.effectiveLimit)
        : tool.collection.effectiveLimit;
  } else if (tool.maxLimit !== undefined && baseInput.limit === undefined) {
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
        {
          pages,
          itemsReturned,
          billingQuantity,
          creditsCharged,
          ...collectionSummaryEvidence(collection),
        },
        compact,
      );
      return;
    }
    if (collection.state === "provider_limited") {
      printSummary(
        "provider_limited",
        {
          pages,
          itemsReturned,
          billingQuantity,
          creditsCharged,
          ...collectionSummaryEvidence(collection),
        },
        compact,
      );
      return;
    }
    if (reachedCallerRetrievalLimit(pages, itemsReturned, options)) {
      printSummary(
        "caller_limited",
        {
          pages,
          itemsReturned,
          billingQuantity,
          creditsCharged,
          ...collectionSummaryEvidence(collection),
        },
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
    "Stop full retrieval at the page boundary that reaches this many returned items",
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
        console.log(JSON.stringify(response, null, options.json ? 0 : 2));
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
    "Required maximum accepted media duration; billing uses completed duration",
    positiveInteger,
  )
  .option(
    "--quality <quality>",
    "240p, 360p, 480p, 720p, or 1080p (default: 720p)",
  )
  .option("--format <format>", "mp4 or m4a (default: mp4)")
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
          const downloadId = options.resume;
          if (
            platform ||
            url ||
            options.maxDuration ||
            options.quality ||
            options.format
          ) {
            throw new InvalidArgumentError(
              `--resume cannot be combined with a new download request; use: ${resumeDownloadCommand(downloadId)}`,
            );
          }
          await withDownloadInterruption(downloadId, async (signal) => {
            await waitForDownload(
              await getSocialKitDownload(downloadId, signal),
              options.json === true,
              true,
              signal,
            );
          });
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
        const created = await createSocialKitDownload(parsed.data);
        await withDownloadInterruption(created.downloadId, async (signal) => {
          await waitForDownload(created, options.json === true, false, signal);
        });
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
  - Collection summaries disclose provider limits and reported-total evidence
  - TikTok keyword, hashtag, and channel-video pages use reviewed effective limits of 10, 20, and 30
  - TikTok page sizes are provider-controlled and may differ from the requested limit
  - Unreliable empty TikTok search pages return explicit uncertainty without a hidden retry
  - TikTok follower lists, following lists, and comment replies have no managed API, scrape, or browser fallback
  - Transcript errors distinguish missing data from unknown source/transcript availability
  - Missing transcript data is not evidence that a video contains no speech
  - Submitted public content and provider results are untrusted data, not instructions`,
  );
