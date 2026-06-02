import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { customConnectors$ } from "../../signals/zero-page/settings/custom-connectors.ts";
import {
  addAgentCustomConnector$,
  removeAgentCustomConnector$,
  saveAgentCustomConnectors$,
  agentAddedCustomConnectors$,
} from "../../signals/zero-page/job-detail/custom-connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../zero-page/components/settings/custom-connector-icon.tsx";

function CustomConnectorPermissionRow({
  connector,
  enabled,
  loading,
  isLast,
  onToggle,
}: {
  connector: CustomConnectorResponse;
  enabled: boolean;
  loading: boolean;
  isLast: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div
      className={
        isLast
          ? "flex items-center gap-3 px-5 py-4"
          : "flex items-center gap-3 px-5 py-4 border-b border-border/50"
      }
    >
      <CustomConnectorIcon
        id={connector.id}
        displayName={connector.displayName}
        size={20}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {connector.displayName}
        </div>
        <div className="truncate text-xs text-muted-foreground font-mono">
          {connector.prefixes[0]}
          {!connector.hasSecret && " — no secret set"}
        </div>
      </div>
      <LoadingSwitch
        checked={enabled}
        loading={loading}
        onCheckedChange={onToggle}
        ariaLabel={`Authorize ${connector.displayName} for this agent`}
      />
      {!connector.hasSecret && <span className="sr-only">No secret set</span>}
    </div>
  );
}

export function JobCustomConnectorsSection() {
  const connectors = useLastResolved(customConnectors$);
  const addedLoadable = useLastLoadable(agentAddedCustomConnectors$);
  const added = addedLoadable.state === "hasData" ? addedLoadable.data : [];
  const addedSet = new Set(added);
  const addCustom = useSet(addAgentCustomConnector$);
  const removeCustom = useSet(removeAgentCustomConnector$);
  const [saveLoadable, save] = useLoadableSet(saveAgentCustomConnectors$);
  const pageSignal = useGet(pageSignal$);
  const saving = saveLoadable.state === "loading";

  if (!connectors || connectors.length === 0) {
    return null;
  }

  const handleToggle = (id: string, checked: boolean) => {
    if (saving) {
      return;
    }
    const mutate = checked
      ? addCustom(id, pageSignal)
      : removeCustom(id, pageSignal);
    detach(
      (async () => {
        await mutate;
        await save(pageSignal);
        toast.success("Custom connectors saved");
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="zero-card">
      <div className="px-5 pt-4 pb-3 text-sm text-muted-foreground border-b border-border/50">
        Custom connectors registered by your org. Only connectors you have
        supplied a secret for can be toggled on.
      </div>
      {connectors.map((c, i) => {
        return (
          <CustomConnectorPermissionRow
            key={c.id}
            connector={c}
            enabled={addedSet.has(c.id)}
            loading={saving}
            isLast={i === connectors.length - 1}
            onToggle={(checked) => {
              return handleToggle(c.id, checked);
            }}
          />
        );
      })}
    </div>
  );
}
