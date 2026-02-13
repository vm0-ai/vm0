import {
  IconClock,
  IconRepeat,
  IconTool,
  IconRobot,
  IconTerminal,
} from "@tabler/icons-react";
import { Markdown } from "../../components/markdown.tsx";
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
          {items.map((item) => (
            <span key={item} className="text-xs text-muted-foreground">
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

function ModelUsagePopover({
  modelUsage,
}: {
  modelUsage: Record<
    string,
    {
      costUSD?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    }
  >;
}) {
  const entries = Object.entries(modelUsage).filter(
    ([, usage]) => usage.inputTokens || usage.outputTokens,
  );

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
          {entries.map(([model, usage]) => (
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
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Exported for use in GroupedMessageCard
export function ResultEventContent({ eventData }: { eventData: EventData }) {
  const durationMs = eventData.duration_ms;
  const numTurns = eventData.num_turns;
  const modelUsage = eventData.modelUsage;
  const result = eventData.result;

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
