import { useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import {
  configDialogOpen$,
  closeConfigDialog$,
  configActiveTab$,
  setConfigActiveTab$,
  configDialogBuilding$,
  configDialogSaveError$,
  configDialogValid$,
  buildConfigDialog$,
} from "../../../signals/agent-detail/config-dialog.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { YamlTab } from "./yaml-tab.tsx";
import { FormsTab } from "./forms-tab.tsx";

export function ConfigDialog() {
  const open = useGet(configDialogOpen$);
  const activeTab = useGet(configActiveTab$);
  const building = useGet(configDialogBuilding$);
  const valid = useGet(configDialogValid$);
  const saveError = useGet(configDialogSaveError$);
  const close = useSet(closeConfigDialog$);
  const setTab = useSet(setConfigActiveTab$);
  const build = useSet(buildConfigDialog$);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Your agent configs</DialogTitle>
          <DialogDescription>This is your agent yamls</DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="yaml">vm0.yaml</TabsTrigger>
            <TabsTrigger value="forms">Forms</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="min-h-[300px]">
          {activeTab === "yaml" ? <YamlTab /> : <FormsTab />}
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={building}>
            Cancel
          </Button>
          <Button
            onClick={() => detach(build(), Reason.DomCallback)}
            disabled={building || !valid}
          >
            {building ? "Building..." : "Build"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
