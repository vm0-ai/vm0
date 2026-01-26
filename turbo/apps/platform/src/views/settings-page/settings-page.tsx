import { useGet, useSet, useLastResolved } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { AppShell } from "../layout/app-shell.tsx";
import {
  settingsTokenValue$,
  setSettingsTokenValue$,
  settingsIsEditing$,
  setSettingsIsEditing$,
  saveModelProvider$,
  cancelSettingsEdit$,
  existingTokenMask$,
} from "../../signals/settings-page/settings-page.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function SettingsPage() {
  return (
    <AppShell
      breadcrumb={["Settings"]}
      title="Settings"
      subtitle="Your project settings"
    >
      <div className="flex flex-col gap-6 px-8 pb-8">
        <ModelProviderTab />
        <ModelProviderCard />
      </div>
    </AppShell>
  );
}

function ModelProviderTab() {
  return (
    <div className="flex gap-2">
      <button className="px-4 py-2 text-sm font-medium border border-border rounded-full bg-background">
        Model provider
      </button>
    </div>
  );
}

function ModelProviderCard() {
  const tokenValue = useGet(settingsTokenValue$);
  const setTokenValue = useSet(setSettingsTokenValue$);
  const isEditing = useGet(settingsIsEditing$);
  const setIsEditing = useSet(setSettingsIsEditing$);
  const saveProvider = useSet(saveModelProvider$);
  const cancelEdit = useSet(cancelSettingsEdit$);
  const existingMask = useLastResolved(existingTokenMask$);
  const pageSignal = useGet(pageSignal$);

  const handleSave = () => {
    detach(saveProvider(pageSignal), Reason.DomCallback);
  };

  const handleCancel = () => {
    cancelEdit();
  };

  return (
    <Card className="p-6 border-dashed">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-medium text-foreground">
            Manage your model provider
          </h3>
          <p className="text-sm text-muted-foreground">
            An OAuth token is required to run Claude Code in sandboxes.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            Claude Code OAuth token
          </label>
          {isEditing ? (
            <Input
              placeholder="sk-ant-oa..."
              value={tokenValue}
              onChange={(e) => setTokenValue(e.target.value)}
            />
          ) : (
            <Input
              value={existingMask || ""}
              placeholder="sk-ant-oa..."
              readOnly
              onClick={() => setIsEditing(true)}
              className="cursor-pointer"
            />
          )}
          <p className="text-xs text-muted-foreground">
            You can find it by entering Claude set-up token in your terminal.
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!tokenValue && isEditing}
            size="sm"
          >
            Save
          </Button>
          <Button variant="outline" onClick={handleCancel} size="sm">
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
