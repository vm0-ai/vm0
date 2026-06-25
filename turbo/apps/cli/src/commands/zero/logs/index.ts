import { Command } from "commander";
import chalk from "chalk";
import { getZeroRunAgentEvents, type RunEvent } from "../../../lib/api";
import { parseTime } from "../../../lib/utils/time-parser";
import { EventStreamNormalizer } from "../../../lib/events/event-stream-normalizer";
import { EventRenderer } from "../../../lib/events/event-renderer";
import {
  collectLogItems,
  parsePositiveLogCount,
} from "../../../lib/utils/log-pagination";
import { withErrorHandler } from "../../../lib/command";
import { isUUID } from "../../run/shared";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { isSupportedFramework } from "@vm0/core/frameworks";

const PAGE_LIMIT = 100;

interface AgentEventWithFramework {
  readonly event: RunEvent;
  readonly framework?: string;
  readonly useDefaultFramework: boolean;
}

function supportedLogFramework(
  framework: string | undefined,
): string | undefined {
  return isSupportedFramework(framework) ? framework : undefined;
}

function hasLogFramework(framework: string | null | undefined): boolean {
  return framework !== undefined && framework !== null;
}

function renderAgentEvent(
  event: RunEvent,
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
  framework: string | undefined,
): void {
  const parsedEvents = normalizer.process(
    event.eventData,
    framework,
    new Date(event.createdAt),
  );
  for (const parsed of parsedEvents) {
    renderer.render(parsed);
  }
}

async function showAgentEvents(
  runId: string,
  options: {
    since?: number;
    targetCount: number | "all";
    order: "asc" | "desc";
  },
): Promise<void> {
  const events = await collectLogItems<AgentEventWithFramework>({
    fetchPage: async (request) => {
      const response = await getZeroRunAgentEvents(runId, request);
      const responseFramework: string | null | undefined = response.framework;
      return {
        items: response.events.map((event) => {
          const framework = supportedLogFramework(
            responseFramework ?? undefined,
          );
          return {
            event,
            ...(framework ? { framework } : {}),
            useDefaultFramework: !hasLogFramework(responseFramework),
          };
        }),
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      };
    },
    sinceTime: options.since,
    targetCount: options.targetCount,
    order: options.order,
    pageLimit: PAGE_LIMIT,
  });

  if (events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

  const renderer = new EventRenderer({
    showTimestamp: true,
    verbose: true,
  });
  const framework = events.find((item) => {
    return item.framework !== undefined;
  })?.framework;
  const normalizer = new EventStreamNormalizer();

  for (const item of events) {
    renderAgentEvent(
      item.event,
      renderer,
      normalizer,
      item.framework ?? (item.useDefaultFramework ? framework : undefined),
    );
  }
  for (const parsed of normalizer.flush()) {
    renderer.render(parsed);
  }
  renderer.flush();
}

export const zeroLogsCommand = new Command()
  .name("logs")
  .description("View and search agent run logs")
  .argument("[runId]", "Run ID to view agent events for")
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .option(
    "--since <time>",
    "Show logs since timestamp (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z)",
  )
  .option("--tail <n>", "Show last N entries (default: 5)")
  .option("--head <n>", "Show first N entries")
  .option("--all", "Fetch all log entries")
  .addHelpText(
    "after",
    `
Examples:
  zero logs list
  zero logs <runId>
  zero logs <runId> --tail 10
  zero logs <runId> --all
  zero logs search "error"`,
  )
  .action(
    withErrorHandler(
      async (
        runId: string | undefined,
        options: {
          since?: string;
          tail?: string;
          head?: string;
          all?: boolean;
        },
      ) => {
        if (!runId) {
          zeroLogsCommand.help();
          return;
        }

        if (!isUUID(runId)) {
          console.error(
            chalk.red(`✗ Invalid run ID "${runId}" — expected a UUID`),
          );
          console.error(chalk.dim("  Run: zero logs list    to find run IDs"));
          process.exit(1);
        }

        const countModes = [
          options.tail !== undefined,
          options.head !== undefined,
          options.all === true,
        ].filter(Boolean).length;
        if (countModes > 1) {
          throw new Error(
            "Options --tail, --head, and --all are mutually exclusive",
          );
        }

        let since: number | undefined;
        if (options.since !== undefined) {
          since = parseTime(options.since);
        }

        const isAll = options.all === true;
        const isHead = options.head !== undefined;
        const isTail = options.tail !== undefined;

        let targetCount: number | "all";
        if (isAll) {
          targetCount = "all";
        } else if (isHead) {
          targetCount = parsePositiveLogCount(options.head!, "--head");
        } else if (isTail) {
          targetCount = parsePositiveLogCount(options.tail!, "--tail");
        } else {
          targetCount = 5;
        }

        const order: "asc" | "desc" = isHead ? "asc" : "desc";

        await showAgentEvents(runId, { since, targetCount, order });
      },
    ),
  );
