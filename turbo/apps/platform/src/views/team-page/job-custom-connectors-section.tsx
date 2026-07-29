import { useGet, useLastLoadable, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { CustomConnectorResponse } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { customConnectors$ } from "../../signals/zero-page/settings/custom-connectors.ts";
import {
  agentCustomConnectorToggleSaving$,
  agentAddedCustomConnectors$,
  toggleAgentCustomConnector$,
} from "../../signals/zero-page/job-detail/custom-connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { CustomConnectorIcon } from "../zero-page/components/settings/custom-connector-icon.tsx";

function CustomConnectorPermissionRow({
  connector,
  enabled,
  loading,
  disabled,
  isLast,
  onToggle,
}: {
  connector: CustomConnectorResponse;
  enabled: boolean;
  loading: boolean;
  disabled: boolean;
  isLast: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const { t } = useTranslation("agents");
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
          {!connector.hasSecret &&
            t(($) => {
              return $.authorization.customConnectors.noSecretSuffix;
            })}
        </div>
      </div>
      <LoadingSwitch
        checked={enabled}
        loading={loading}
        disabled={disabled}
        onCheckedChange={onToggle}
        ariaLabel={t(
          ($) => {
            return $.authorization.customConnectors.authorize;
          },
          { connectorName: connector.displayName },
        )}
      />
      {!connector.hasSecret && (
        <span className="sr-only">
          {t(($) => {
            return $.authorization.customConnectors.noSecret;
          })}
        </span>
      )}
    </div>
  );
}

export function JobCustomConnectorsSection() {
  const { t } = useTranslation("agents");
  const connectors = useLastResolved(customConnectors$);
  const addedLoadable = useLastLoadable(agentAddedCustomConnectors$);
  const added = addedLoadable.state === "hasData" ? addedLoadable.data : [];
  const addedSet = new Set(added);
  const [, toggle] = useLoadableSet(toggleAgentCustomConnector$);
  const pageSignal = useGet(pageSignal$);
  const saving = useGet(agentCustomConnectorToggleSaving$);

  if (!connectors || connectors.length === 0) {
    return null;
  }

  const handleToggle = (id: string, checked: boolean) => {
    if (saving) {
      return;
    }
    detach(
      (async () => {
        const saved = await toggle(id, checked, pageSignal);
        if (saved) {
          toast.success(
            t(($) => {
              return $.authorization.customConnectors.saved;
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div className="zero-card">
      <div className="px-5 pt-4 pb-3 text-sm text-muted-foreground border-b border-border/50">
        {t(($) => {
          return $.authorization.customConnectors.description;
        })}
      </div>
      {connectors.map((c, i) => {
        const enabled = addedSet.has(c.id);
        return (
          <CustomConnectorPermissionRow
            key={c.id}
            connector={c}
            enabled={enabled}
            loading={saving}
            disabled={!c.hasSecret && !enabled}
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
