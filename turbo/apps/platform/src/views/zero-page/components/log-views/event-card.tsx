import {
  IconClock,
  IconRepeat,
  IconTool,
  IconRobot,
  IconTerminal,
} from "@tabler/icons-react";
import { nowDate } from "../../../../lib/time.ts";
import { Markdown } from "../../../components/markdown.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@vm0/ui";

type ModelUsage = Record<
  string,
  {
    costUSD?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }
>;

// Exported for reuse
export function formatEventTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString.trim().length > 0 ? isoString : "—";
  }
  const now = nowDate();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Exported for reuse
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

// ============ SYSTEM EVENT (Init) ============

function CategoryPopover({
  icon: Icon,
  label,
  count,
  items,
}: {
  icon: typeof IconTool;
  label: string;
  count: number;
  items: string[];
}) {
  const itemKeyCounts = new Map<string, number>();

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <Icon className="h-3 w-3" />
        <span>
          {count} {label}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-h-64 overflow-y-auto p-3"
      >
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => {
            const occurrence = itemKeyCounts.get(item) ?? 0;
            itemKeyCounts.set(item, occurrence + 1);
            return (
              <span
                key={occurrence === 0 ? item : `${item}:${occurrence}`}
                className="text-xs text-muted-foreground"
              >
                {item}
              </span>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : null;
}

function toModelUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([model, usage]) => {
    if (!isRecord(usage)) {
      return [];
    }
    return [
      [
        model,
        {
          costUSD: toNonNegativeFiniteNumber(usage.costUSD),
          inputTokens: toNonNegativeInteger(usage.inputTokens),
          outputTokens: toNonNegativeInteger(usage.outputTokens),
        },
      ],
    ];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Exported for use in GroupedMessageCard
export function SystemInitContent({ eventData }: { eventData: unknown }) {
  const data = isRecord(eventData) ? eventData : {};
  const tools = toStringList(data.tools);
  const agents = toStringList(data.agents);
  const slashCommands = toStringList(data.slash_commands);

  const hasAnyItems =
    tools.length > 0 || agents.length > 0 || slashCommands.length > 0;

  if (!hasAnyItems) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {tools.length > 0 && (
        <CategoryPopover
          icon={IconTool}
          label="tools"
          count={tools.length}
          items={tools}
        />
      )}
      {agents.length > 0 && (
        <CategoryPopover
          icon={IconRobot}
          label="agents"
          count={agents.length}
          items={agents}
        />
      )}
      {slashCommands.length > 0 && (
        <CategoryPopover
          icon={IconTerminal}
          label="commands"
          count={slashCommands.length}
          items={slashCommands.map((cmd) => {
            return `/${cmd}`;
          })}
        />
      )}
    </div>
  );
}

// ============ RESULT EVENT (Final stats) ============

function ModelUsagePopover({ modelUsage }: { modelUsage: ModelUsage }) {
  const entries = Object.entries(modelUsage).filter(([, usage]) => {
    return usage.inputTokens || usage.outputTokens;
  });

  if (entries.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
        <IconTool className="h-3 w-3" />
        <span>{entries.length} models</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-h-64 overflow-y-auto p-3"
      >
        <div className="space-y-1.5">
          {entries.map(([model, usage]) => {
            return (
              <div key={model} className="text-xs font-mono">
                <div className="text-foreground font-medium">{model}</div>
                <div className="text-muted-foreground pl-2">
                  {usage.inputTokens && (
                    <div>in: {usage.inputTokens.toLocaleString()}</div>
                  )}
                  {usage.outputTokens && (
                    <div>out: {usage.outputTokens.toLocaleString()}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Exported for use in GroupedMessageCard
export function ResultEventContent({ eventData }: { eventData: unknown }) {
  const data = isRecord(eventData) ? eventData : {};
  const durationMs = toNonNegativeFiniteNumber(data.duration_ms);
  const numTurns = toNonNegativeInteger(data.num_turns);
  const modelUsage = toModelUsage(data.modelUsage);
  const result = typeof data.result === "string" ? data.result : null;

  return (
    <div className="space-y-2">
      {/* Summary stats - horizontal layout like SystemInitContent */}
      <div className="flex flex-wrap gap-2">
        {durationMs !== null && durationMs !== undefined && (
          <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <IconClock className="h-3 w-3" />
            <span>{formatDuration(durationMs)}</span>
          </div>
        )}
        {numTurns !== null && numTurns !== undefined && (
          <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <IconRepeat className="h-3 w-3" />
            <span>{numTurns} turns</span>
          </div>
        )}
        {modelUsage && Object.keys(modelUsage).length > 0 && (
          <ModelUsagePopover modelUsage={modelUsage} />
        )}
      </div>

      {/* Result text */}
      {result && (
        <div className="pt-1">
          <Markdown source={result} />
        </div>
      )}
    </div>
  );
}
