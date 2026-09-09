import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { updateAgentSshAccess$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ConnectorPermissionRow } from "./components/settings/connector-permission-row.tsx";

export function AgentSshAccess({
  agentId,
  enabled,
}: {
  readonly agentId: string;
  readonly enabled: boolean;
}) {
  const { t } = useTranslation();
  const [saving, update] = useLoadableSet(updateAgentSshAccess$);
  const signal = useGet(pageSignal$);
  return (
    <ConnectorPermissionRow
      icon={<Terminal size={20} className="shrink-0" aria-hidden="true" />}
      label={t(($) => {
        return $.ssh.label;
      })}
      description={t(($) => {
        return $.ssh.accessHelp;
      })}
      enabled={enabled}
      loading={saving.state === "loading"}
      showManage={false}
      isLast
      onToggle={(checked) => {
        return detach(update(agentId, checked, signal), Reason.DomCallback);
      }}
    />
  );
}
