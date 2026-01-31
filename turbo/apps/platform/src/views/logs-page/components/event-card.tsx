import {
  IconClock,
  IconCurrencyDollar,
  IconArrowRight,
  IconTool,
  IconRobot,
  IconTerminal,
} from "@tabler/icons-react";
import MarkdownPreview from "@uiw/react-markdown-preview";
import { Popover, PopoverContent, PopoverTrigger } from "@vm0/ui";

// Type definitions for EventData
interface MessageData {
  content: unknown[] | null;
  id: string | null;
  model: string | null;
  role: string | null;
  stop_reason: string | null;
  usage?: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
  };
}

interface ToolResultMeta {
  bytes?: number | null;
  code?: number | null;
  codeText?: string | null;
  durationMs?: number | null;
  url?: string | null;
  filePath?: string | null;
  query?: string | null;
  result?: string | null;
}

export interface EventData {
  type?: string;
  subtype?: string;
  message?: MessageData;
  tool_use_result?: ToolResultMeta;
  model?: string;
  session_id?: string;
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  total_cost_usd?: number | null;
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  num_turns?: number | null;
  modelUsage?: Record<
    string,
    {
      costUSD?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    }
  >;
  is_error?: boolean;
  result?: string | null;
}

// Exported for reuse
export function formatEventTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
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

function formatCost(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
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
  return (
    <Popover>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-xs font-medium bg-background border border-border text-muted-foreground hover:bg-muted transition-colors cursor-pointer">
        <Icon className="h-3.5 w-3.5" />
        <span>{count}</span>
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-h-64 overflow-y-auto p-3 bg-card"
      >
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item}
              className="text-xs font-medium text-muted-foreground bg-background border border-border px-1.5 py-0.5 rounded-md"
            >
              {item}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Exported for use in GroupedMessageCard
export function SystemInitContent({ eventData }: { eventData: EventData }) {
  const tools = eventData.tools ?? [];
  const agents = eventData.agents ?? [];
  const slashCommands = eventData.slash_commands ?? [];

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
          items={slashCommands.map((cmd) => `/${cmd}`)}
        />
      )}
    </div>
  );
}

// ============ RESULT EVENT (Final stats) ============

// Exported for use in GroupedMessageCard
export function ResultEventContent({ eventData }: { eventData: EventData }) {
  const totalCost = eventData.total_cost_usd;
  const durationMs = eventData.duration_ms;
  const numTurns = eventData.num_turns;
  const modelUsage = eventData.modelUsage;
  const result = eventData.result;

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="flex flex-wrap gap-4 text-sm">
        {durationMs !== null && durationMs !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">
              {formatDuration(durationMs)}
            </span>
          </div>
        )}
        {totalCost !== null && totalCost !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconCurrencyDollar className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">{formatCost(totalCost)}</span>
          </div>
        )}
        {numTurns !== null && numTurns !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconArrowRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">{numTurns} turns</span>
          </div>
        )}
      </div>

      {/* Model usage breakdown */}
      {modelUsage && Object.keys(modelUsage).length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Model Usage ({Object.keys(modelUsage).length})
          </summary>
          <div className="mt-2 space-y-1">
            {Object.entries(modelUsage).map(([model, usage]) => {
              if (!usage.inputTokens && !usage.outputTokens) {
                return null;
              }
              return (
                <div
                  key={model}
                  className="flex items-center justify-between gap-4 text-xs bg-background px-3 py-2 rounded-md"
                >
                  <span className="font-mono text-muted-foreground truncate min-w-0">
                    {model}
                  </span>
                  <div className="flex gap-3 shrink-0 text-foreground">
                    {usage.inputTokens !== null &&
                      usage.inputTokens !== undefined && (
                        <span>
                          <span className="text-muted-foreground">In:</span>{" "}
                          {usage.inputTokens.toLocaleString()}
                        </span>
                      )}
                    {usage.outputTokens !== null &&
                      usage.outputTokens !== undefined && (
                        <span>
                          <span className="text-muted-foreground">Out:</span>{" "}
                          {usage.outputTokens.toLocaleString()}
                        </span>
                      )}
                    {usage.costUSD !== null && usage.costUSD !== undefined && (
                      <span className="text-emerald-600 font-medium">
                        {formatCost(usage.costUSD)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Result text */}
      {result && (
        <MarkdownPreview
          source={result}
          className="!bg-transparent !text-foreground text-sm"
          style={{
            backgroundColor: "transparent",
            fontSize: "0.875rem",
            lineHeight: "1.5",
          }}
        />
      )}
    </div>
  );
}
