import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { IconPlus } from "@tabler/icons-react";
import type { ConnectorType } from "@vm0/core";
import { skills$ } from "../../data/skills.ts";
import { ZeroSkillCard } from "./zero-skill-card.tsx";
import {
  allConnectorTypes$,
  connectConnector$,
  addConnectionDialogOpen$,
  setAddConnectionDialogOpen$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/settings-page/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  AddConnectionDialog,
  ConnectModal,
} from "../settings-page/add-connection-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";

interface ZeroSkillsTabProps {
  addedSkills: string[];
  addedSkillsLoading: boolean;
  skillsDirty: boolean;
  skillsSaving: boolean;
  onAddSkill: (name: string) => void;
  onRemoveSkill: (name: string) => void;
  onSaveSkills: () => void;
  onDiscardSkills: () => void;
}

export function ZeroSkillsTab({
  addedSkills,
  addedSkillsLoading,
  skillsDirty,
  skillsSaving,
  onAddSkill,
  onRemoveSkill,
  onSaveSkills,
  onDiscardSkills,
}: ZeroSkillsTabProps) {
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const disconnect = useSet(deleteConnector$);
  const signal = useGet(pageSignal$);
  const addDialogOpen = useGet(addConnectionDialogOpen$);
  const setAddDialogOpen = useSet(setAddConnectionDialogOpen$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);

  const allSkills = useGet(skills$);

  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  if (allTypesLoadable.state === "hasData" && optimisticConnected.size > 0) {
    clearOptimistic();
  }
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const skillMap = new Map(allSkills.map((s) => [s.value, s]));
  const addedSet = new Set(addedSkills);

  const handleConnectSuccess = (type: string) => {
    onAddSkill(type);
    const label =
      skillMap.get(type)?.label ??
      connectorMap.get(type as ConnectorType)?.label ??
      type;
    toast.success(`${label} added to connectors`);
  };

  const handleRemoveSkill = (name: string) => {
    onRemoveSkill(name);
    const label =
      skillMap.get(name)?.label ??
      connectorMap.get(name as ConnectorType)?.label ??
      name;
    toast.success(`${label} removed from connectors`);
  };

  return (
    <div className="mx-auto max-w-[900px] flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add skill */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-border/80 transition-colors hover:border-border hover:bg-muted/30 group"
        >
          <div className="flex h-14 items-center gap-2.5 px-5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center">
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
          <div className="flex h-11 items-center border-t border-dashed border-border/80 px-5 group-hover:border-border">
            <span className="text-xs text-muted-foreground/70">
              Browse 100+ popular connectors
            </span>
          </div>
        </button>

        {/* Skeleton cards while loading */}
        {addedSkillsLoading && (
          <>
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="flex flex-col rounded-[var(--zero-card-radius)] border border-border/50 bg-card animate-pulse"
              >
                <div className="flex h-14 items-center gap-2.5 px-5">
                  <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
                  <span className="h-4 w-24 rounded bg-muted/50" />
                </div>
                <div className="flex h-11 items-center border-t border-border/30 px-5">
                  <span className="h-3 w-16 rounded bg-muted/30" />
                </div>
              </div>
            ))}
          </>
        )}

        {/* Skill cards */}
        {addedSkills.map((name) => {
          const skill = skillMap.get(name);
          const connector = connectorMap.get(name as ConnectorType) ?? null;
          const effectiveConnector =
            optimisticConnected.has(name) && connector && !connector.connected
              ? { ...connector, connected: true }
              : connector;
          return (
            <ZeroSkillCard
              key={name}
              name={name}
              label={skill?.label ?? name}
              iconUrl={skill?.icon}
              connector={effectiveConnector}
              pollingType={pollingType}
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
                detach(disconnect(name as ConnectorType), Reason.DomCallback);
                const label =
                  skillMap.get(name)?.label ??
                  connectorMap.get(name as ConnectorType)?.label ??
                  name;
                toast.success(`${label} disconnected`);
              }}
              onRemove={() => handleRemoveSkill(name)}
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

      {(skillsDirty || skillsSaving) && (
        <ZeroUnsavedBar
          onDiscard={onDiscardSkills}
          onSave={onSaveSkills}
          saving={skillsSaving}
        />
      )}
    </div>
  );
}
