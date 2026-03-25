import { useState } from "react";
import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { IconPlus } from "@tabler/icons-react";
import type { ConnectorType, FirewallPolicies } from "@vm0/core";
import { ZeroConnectorCard } from "./zero-connector-card.tsx";
import {
  allConnectorTypes$,
  connectConnector$,
  addConnectionDialogOpen$,
  setAddConnectionDialogOpen$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingConnectorType$,
  justConnectedTypes$,
  scopeReviewType$,
  setScopeReviewType$,
} from "../../signals/zero-page/settings/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  AddConnectionDialog,
  ConnectModal,
} from "./components/settings/add-connection-dialog.tsx";
import { ScopeReviewModal } from "./components/settings/scope-review-modal.tsx";
import { FirewallPermissionsDrawer } from "./components/settings/firewall-permissions-dialog.tsx";
import {
  hasFirewallConfig,
  saveFirewallPolicies$,
} from "../../signals/zero-page/settings/firewalls.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";

interface ZeroConnectorsTabProps {
  addedConnectors: string[];
  addedConnectorsLoading: boolean;
  connectorsDirty: boolean;
  connectorsSaving: boolean;
  onAddConnector: (name: string) => void;
  onRemoveConnector: (name: string) => void;
  onSaveConnectors: () => void;
  onDiscardConnectors: () => void;
  agentId?: string;
  displayName?: string;
  firewallPolicies?: FirewallPolicies | null;
  onFirewallPoliciesChange?: (policies: FirewallPolicies | null) => void;
  /** When true, hide agent-level mutations (add/remove/save). Connect/Disconnect still works. */
  readOnly?: boolean;
}

export function ZeroConnectorsTab({
  addedConnectors,
  addedConnectorsLoading,
  connectorsDirty,
  connectorsSaving,
  agentId,
  displayName,
  firewallPolicies,
  onFirewallPoliciesChange,
  onAddConnector,
  onRemoveConnector,
  onSaveConnectors,
  onDiscardConnectors,
  readOnly,
}: ZeroConnectorsTabProps) {
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const disconnect = useSet(deleteConnector$);
  const signal = useGet(pageSignal$);
  const addDialogOpen = useGet(addConnectionDialogOpen$);
  const setAddDialogOpen = useSet(setAddConnectionDialogOpen$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);

  const scopeReviewType = useGet(scopeReviewType$);
  const setScopeReviewType = useSet(setScopeReviewType$);

  const [firewallType, setFirewallType] = useState<ConnectorType | null>(null);
  const saveFirewallPol = useSet(saveFirewallPolicies$);

  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  const optimisticConnected = useGet(justConnectedTypes$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const addedSet = new Set(addedConnectors);

  const handleConnectSuccess = (type: string) => {
    onAddConnector(type);
    const label = connectorMap.get(type as ConnectorType)?.label ?? type;
    toast.success(`${label} added to connectors`);
  };

  const handleRemoveConnector = (name: string) => {
    onRemoveConnector(name);
    const label = connectorMap.get(name as ConnectorType)?.label ?? name;
    toast.success(`${label} removed from connectors`);
  };

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add connector — hidden for read-only members on the default agent */}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setAddDialogOpen(true)}
            className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-[hsl(var(--gray-400))] transition-colors hover:border-[hsl(var(--gray-400))] hover:bg-muted/30 group"
          >
            <div className="flex h-14 items-center gap-2.5 px-5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <IconPlus
                  size={18}
                  stroke={2}
                  className="text-muted-foreground group-hover:text-foreground"
                />
              </span>
              <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
                Add connector
              </span>
            </div>
            <div className="flex h-11 items-center border-t border-dashed border-[hsl(var(--gray-400))] px-5 group-hover:border-[hsl(var(--gray-400))]">
              <span className="text-xs text-muted-foreground/70">
                Browse 100+ popular connectors
              </span>
            </div>
          </button>
        )}

        {/* Skeleton cards while loading */}
        {addedConnectorsLoading && (
          <>
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="flex flex-col rounded-[var(--zero-card-radius)] border border-border/50 bg-card animate-pulse"
              >
                <div className="flex h-14 items-center gap-2.5 px-5">
                  <span className="h-5 w-5 shrink-0 rounded-lg bg-muted/50" />
                  <span className="h-4 w-24 rounded bg-muted/50" />
                </div>
                <div className="flex h-11 items-center border-t border-border/30 px-5">
                  <span className="h-3 w-16 rounded bg-muted/30" />
                </div>
              </div>
            ))}
          </>
        )}

        {/* Connector cards — only show connectors that have a matching connector type */}
        {addedConnectors
          .filter((name) => connectorMap.has(name as ConnectorType))
          .map((name) => {
            const connector = connectorMap.get(name as ConnectorType) ?? null;
            const effectiveConnector =
              optimisticConnected.has(name) && connector && !connector.connected
                ? { ...connector, connected: true }
                : connector;
            return (
              <ZeroConnectorCard
                key={name}
                name={name}
                label={connectorMap.get(name as ConnectorType)?.label ?? name}
                connector={effectiveConnector}
                pollingType={pollingType}
                hasFirewall={hasFirewallConfig(name as ConnectorType)}
                isAdmin={isAdmin}
                readOnly={readOnly}
                onConnect={() => {
                  const ct = connectorMap.get(name as ConnectorType);
                  if (
                    ct &&
                    ct.availableAuthMethods.length === 1 &&
                    ct.availableAuthMethods[0] === "api-token"
                  ) {
                    setSelected(name as ConnectorType);
                  } else {
                    detach(
                      connect(name as ConnectorType, signal),
                      Reason.DomCallback,
                    );
                  }
                }}
                onDisconnect={() => {
                  detach(
                    disconnect(name as ConnectorType, signal),
                    Reason.DomCallback,
                  );
                  const label =
                    connectorMap.get(name as ConnectorType)?.label ?? name;
                  toast.success(`${label} disconnected`);
                }}
                onRemove={() => handleRemoveConnector(name)}
                onReviewScopes={() =>
                  detach(
                    setScopeReviewType(name as ConnectorType, signal),
                    Reason.DomCallback,
                  )
                }
                onManagePermissions={() =>
                  setFirewallType(name as ConnectorType)
                }
              />
            );
          })}
      </div>

      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        variant="zero"
        excludeTypes={addedSet}
        onConnectSuccess={handleConnectSuccess}
        onAdd={handleConnectSuccess}
        displayName={displayName ?? agentId}
      />

      {selectedType && (
        <ConnectModal
          onClose={() => setSelected(null)}
          onSuccess={() => {
            if (selectedType && !addedSet.has(selectedType)) {
              handleConnectSuccess(selectedType);
            }
          }}
        />
      )}

      {scopeReviewType && (
        <ScopeReviewModal
          connectorType={scopeReviewType}
          onClose={() =>
            detach(setScopeReviewType(null, signal), Reason.DomCallback)
          }
          onReconnect={(type) => {
            detach(setScopeReviewType(null, signal), Reason.DomCallback);
            detach(connect(type, signal), Reason.DomCallback);
          }}
        />
      )}

      {firewallType && agentId && (
        <FirewallPermissionsDrawer
          connectorType={firewallType}
          displayName={displayName ?? agentId}
          initialPolicies={firewallPolicies ?? {}}
          onApply={async (policies) => {
            const saved = await saveFirewallPol(agentId, policies, signal);
            if (saved !== undefined) {
              onFirewallPoliciesChange?.(saved);
            }
            toast.success("Permissions updated");
          }}
          onClose={() => setFirewallType(null)}
        />
      )}

      {!readOnly && (connectorsDirty || connectorsSaving) && (
        <ZeroUnsavedBar
          onDiscard={onDiscardConnectors}
          onSave={onSaveConnectors}
          saving={connectorsSaving}
        />
      )}
    </div>
  );
}
