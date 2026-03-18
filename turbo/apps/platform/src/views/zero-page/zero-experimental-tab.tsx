import { Card, CardContent } from "@vm0/ui";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";

interface ZeroExperimentalTabProps {
  capabilities: string[];
  capabilitiesDirty: boolean;
  capabilitiesSaving: boolean;
  onToggleCapability: (capability: string) => void;
  onSaveCapabilities: () => void;
  onDiscardCapabilities: () => void;
}

export function ZeroExperimentalTab({
  capabilities,
  capabilitiesDirty,
  capabilitiesSaving,
  onToggleCapability,
  onSaveCapabilities,
  onDiscardCapabilities,
}: ZeroExperimentalTabProps) {
  const capabilityGroups = [
    {
      label: "Agent Resources",
      capabilities: [
        { key: "agent:read", label: "Read agents & volumes" },
        { key: "agent:write", label: "Write agents & volumes" },
      ],
    },
    {
      label: "Artifacts & Memories",
      capabilities: [
        { key: "artifact:read", label: "Read artifacts & memories" },
        { key: "artifact:write", label: "Write artifacts & memories" },
      ],
    },
    {
      label: "Operations",
      capabilities: [
        { key: "agent-run:read", label: "View agent runs" },
        { key: "agent-run:write", label: "Create & cancel runs" },
        { key: "schedule:read", label: "View schedules" },
        { key: "schedule:write", label: "Manage schedules" },
      ],
    },
  ];

  return (
    <>
      <div className="mx-auto max-w-[900px]">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">
            VM0 Capabilities
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Control what your agent can do on the VM0 platform
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {capabilityGroups.map((group) => (
            <Card key={group.label} className="zero-card-white">
              <CardContent className="py-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  {group.label}
                </h3>
                <div className="flex flex-col divide-y divide-border">
                  {group.capabilities.map((cap) => (
                    <div
                      key={cap.key}
                      className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
                    >
                      <span className="text-sm text-foreground">
                        {cap.label}
                      </span>
                      <LoadingSwitch
                        checked={capabilities.includes(cap.key)}
                        loading={capabilitiesSaving}
                        onCheckedChange={() => onToggleCapability(cap.key)}
                        ariaLabel={cap.label}
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {(capabilitiesDirty || capabilitiesSaving) && (
        <ZeroUnsavedBar
          onDiscard={onDiscardCapabilities}
          onSave={onSaveCapabilities}
          saving={capabilitiesSaving}
        />
      )}
    </>
  );
}
