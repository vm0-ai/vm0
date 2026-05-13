import { Command } from "commander";
import chalk from "chalk";
import { getZeroRunAgentEvents, type RunEvent } from "../../../lib/api";
import { parseTime } from "../../../lib/utils/time-parser";
import { EventStreamNormalizer } from "../../../lib/events/event-stream-normalizer";
import { EventRenderer } from "../../../lib/events/event-renderer";
import { paginate } from "../../../lib/utils/paginate";
import { withErrorHandler } from "../../../lib/command";
import { isUUID } from "../../run/shared";
import { listCommand } from "./list";
import { searchCommand } from "./search";

const PAGE_LIMIT = 100;

function renderAgentEvent(
  event: RunEvent,
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
  framework: string,
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
  const firstResponse = await getZeroRunAgentEvents(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

  let allEvents: RunEvent[];

  if (
    !firstResponse.hasMore ||
    (options.targetCount !== "all" &&
      firstResponse.events.length >= options.targetCount)
  ) {
    allEvents =
      options.targetCount === "all"
        ? firstResponse.events
        : firstResponse.events.slice(0, options.targetCount);
  } else {
    const lastEvent = firstResponse.events[firstResponse.events.length - 1];
    const firstPageTimestamp = lastEvent
      ? new Date(lastEvent.createdAt).getTime()
      : undefined;

    const remainingEvents = await paginate<RunEvent>({
      fetchPage: async (since) => {
        const response = await getZeroRunAgentEvents(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.events, hasMore: response.hasMore };
      },
      getTimestamp: (event) => {
        return new Date(event.createdAt).getTime();
      },
      targetCount:
        options.targetCount === "all"
          ? "all"
          : options.targetCount - firstResponse.events.length,
      initialSince: firstPageTimestamp,
    });

    allEvents = [...firstResponse.events, ...remainingEvents];

    if (
      options.targetCount !== "all" &&
      allEvents.length > options.targetCount
    ) {
      allEvents = allEvents.slice(0, options.targetCount);
    }
  }

  const events =
    options.order === "desc" ? [...allEvents].reverse() : allEvents;

  const renderer = new EventRenderer({
    showTimestamp: true,
    verbose: true,
  });
  const normalizer = new EventStreamNormalizer();
  const framework = firstResponse.framework;

  for (const event of events) {
    renderAgentEvent(event, renderer, normalizer, framework);
  }
  for (const parsed of normalizer.flush()) {
    renderer.render(parsed);
  }
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
        if (options.since) {
          since = parseTime(options.since);
        }

        const isAll = options.all === true;
        const isHead = options.head !== undefined;
        const isTail = options.tail !== undefined;

        let targetCount: number | "all";
        if (isAll) {
          targetCount = "all";
        } else if (isHead) {
          targetCount = Math.max(1, parseInt(options.head!, 10));
        } else if (isTail) {
          targetCount = Math.max(1, parseInt(options.tail!, 10));
        } else {
          targetCount = 5;
        }

        const order: "asc" | "desc" = isHead ? "asc" : "desc";

        await showAgentEvents(runId, { since, targetCount, order });
      },
    ),
  );
