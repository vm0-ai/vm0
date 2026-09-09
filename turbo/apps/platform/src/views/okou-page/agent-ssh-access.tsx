import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Info, Terminal } from "lucide-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { updateCurrentAgentSshAccess$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ConnectorPermissionRow } from "./components/settings/connector-permission-row.tsx";

export function AgentSshAccess({
  agentId,
  enabled,
}: {
  readonly agentId: string;
  readonly enabled: boolean;
}) {
  const { t } = useTranslation();
  const [saving, update] = useLoadableSet(updateCurrentAgentSshAccess$);
  const signal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);
  return (
    <ConnectorPermissionRow
      icon={<Terminal size={20} className="shrink-0" aria-hidden="true" />}
      label={t(($) => {
        return $.ssh.label;
      })}
      description={t(($) => {
        return $.ssh.accessHelp;
      })}
      labelSuffix={
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="icon-xs"
                aria-label={t(($) => {
                  return $.ssh.access;
                })}
              >
                <Info size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                {t(($) => {
                  return $.ssh.accessHelp;
                })}
              </p>
              <p className="mt-2">
                {t(($) => {
                  return $.ssh.cache;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
      enabled={enabled}
      loading={saving.state === "loading"}
      showManage
      manageLabel={t(($) => {
        return $.ssh.manage;
      })}
      isLast
      onManage={() => {
        return navigate(ROUTES.connectorSsh);
      }}
      onToggle={(checked) => {
        return detach(update(agentId, checked, signal), Reason.DomCallback);
      }}
    />
  );
}
