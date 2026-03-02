import { Button } from "@vm0/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  IconPlayerPlay,
  IconSettings,
  IconPlug,
  IconList,
  IconLink,
  IconLoader2,
  IconClockHour3,
  IconEdit,
  IconMessageChatbot,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { openConfigDialog$ } from "../../signals/agent-detail/config-dialog.ts";
import { openRunDialog$ } from "../../signals/agent-detail/run-dialog.ts";
import { runButtonState$ } from "../../signals/agent-detail/inline-run.ts";
import { agentName$ } from "../../signals/agent-detail/agent-detail.ts";
import {
  agentSchedule$,
  agentScheduleSummary$,
  openScheduleDialog$,
} from "../../signals/agent-detail/schedule.ts";
import { openChatPanel$ } from "../../signals/agent-detail/chat.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import type { AgentDetail } from "../../signals/agent-detail/types.ts";
import { Link } from "../router/link.tsx";

interface AgentHeaderProps {
  detail: AgentDetail;
  isOwner: boolean;
}

export function AgentHeader({ detail, isOwner }: AgentHeaderProps) {
  const openConfig = useSet(openConfigDialog$);
  const openRun = useSet(openRunDialog$);
  const openChat = useSet(openChatPanel$);
  const buttonState = useGet(runButtonState$);
  const isBusy = buttonState !== "idle";
  const schedule = useGet(agentSchedule$);
  const scheduleSummary = useGet(agentScheduleSummary$);
  const openSchedule = useSet(openScheduleDialog$);
  const agentName = useGet(agentName$);

  // Extract description from the first agent definition
  const agentKeys = detail.content?.agents
    ? Object.keys(detail.content.agents)
    : [];
  const firstKey = agentKeys[0];
  const agentDef = firstKey ? detail.content?.agents[firstKey] : null;
  const description = agentDef?.description;

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3.5 bg-background -mx-4 px-4 -mt-4 pt-4 pb-4 md:-mx-8 md:px-8 md:-mt-8 md:pt-8 md:pb-[22px]">
      <AgentAvatar name={detail.name} size="lg" className="shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl leading-8 font-normal text-foreground truncate">
            {detail.name}
          </h1>
          {!isOwner && (
            <span className="inline-flex h-[22px] items-center gap-1 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs font-medium leading-4 text-muted-foreground">
              <IconLink size={14} className="shrink-0 text-lime-600" />
              Shared
            </span>
          )}
        </div>
        {description && (
          <p className="text-sm text-muted-foreground truncate">
            {description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <TooltipProvider delayDuration={100}>
          {schedule && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="inline-flex h-9 shrink-0 items-center rounded-md border border-border bg-sidebar">
                  <div className="flex items-center gap-1 pl-2.5 pr-2 py-0.5">
                    <IconClockHour3
                      size={12}
                      className="shrink-0 text-sky-700"
                    />
                    <span className="text-xs font-medium leading-4 text-secondary-foreground max-sm:hidden">
                      Scheduled
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openSchedule()}
                    aria-label="Edit schedule"
                    className="flex h-9 w-9 items-center justify-center border-l border-border text-secondary-foreground hover:bg-accent rounded-r-md cursor-pointer"
                  >
                    <IconEdit size={16} />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent className="whitespace-pre-line">
                {scheduleSummary ?? "Scheduled"}
              </TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="default"
                size="sm"
                onClick={() => openRun()}
                disabled={isBusy}
              >
                {isBusy ? (
                  <IconLoader2 size={16} className="mr-1 animate-spin" />
                ) : (
                  <IconPlayerPlay size={16} className="mr-1" />
                )}
                {buttonState === "starting"
                  ? "Starting..."
                  : buttonState === "running"
                    ? "Running..."
                    : "Run"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {buttonState === "starting"
                ? "Creating run..."
                : buttonState === "running"
                  ? "Run in progress"
                  : "Run agent"}
            </TooltipContent>
          </Tooltip>

          {isOwner && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => openChat()}
                  aria-label="Chat"
                >
                  <IconMessageChatbot size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Chat</TooltipContent>
            </Tooltip>
          )}

          {isOwner && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={() => openConfig()}
                  aria-label="Settings"
                >
                  <IconSettings size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          )}

          {agentName && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  asChild
                >
                  <Link
                    pathname="/agents/:name/connections"
                    options={{ pathParams: { name: agentName } }}
                  >
                    <IconPlug size={18} />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Connections</TooltipContent>
            </Tooltip>
          )}

          {agentName && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  asChild
                >
                  <Link
                    pathname="/agents/:name/logs"
                    options={{ pathParams: { name: agentName } }}
                  >
                    <IconList size={18} />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Logs</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>
    </div>
  );
}
