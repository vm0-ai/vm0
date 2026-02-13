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
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { navigateInReact$ } from "../../signals/route.ts";
import { openConfigDialog$ } from "../../signals/agent-detail/config-dialog.ts";
import { openRunDialog$ } from "../../signals/agent-detail/run-dialog.ts";
import { runButtonState$ } from "../../signals/agent-detail/inline-run.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import type { AgentDetail } from "../../signals/agent-detail/types.ts";

interface AgentHeaderProps {
  detail: AgentDetail;
  isOwner: boolean;
}

export function AgentHeader({ detail, isOwner }: AgentHeaderProps) {
  const navigate = useSet(navigateInReact$);
  const openConfig = useSet(openConfigDialog$);
  const openRun = useSet(openRunDialog$);
  const buttonState = useGet(runButtonState$);
  const isBusy = buttonState !== "idle";

  // Extract description from the first agent definition
  const agentKeys = detail.content?.agents
    ? Object.keys(detail.content.agents)
    : [];
  const firstKey = agentKeys[0];
  const agentDef = firstKey ? detail.content?.agents[firstKey] : null;
  const description = agentDef?.description;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3.5 bg-background -mx-8 px-8 -mt-8 pt-8 pb-[22px]">
      <AgentAvatar name={detail.name} size="lg" />
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
                  onClick={() => openConfig()}
                  aria-label="Settings"
                >
                  <IconSettings size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() =>
                  navigate("/agents/:name/connections", {
                    pathParams: { name: detail.name },
                  })
                }
              >
                <IconPlug size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Connections</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9"
                onClick={() =>
                  navigate("/agents/:name/logs", {
                    pathParams: { name: detail.name },
                  })
                }
              >
                <IconList size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
