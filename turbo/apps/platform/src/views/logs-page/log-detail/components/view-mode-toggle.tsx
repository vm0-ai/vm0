import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import type { ViewMode } from "../../../../signals/logs-page/log-detail-state.ts";

export function ViewModeToggle({
  mode,
  setMode,
}: {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
}) {
  return (
    <Tabs value={mode} onValueChange={(value) => setMode(value as ViewMode)}>
      <TabsList>
        <TabsTrigger value="formatted">Formatted</TabsTrigger>
        <TabsTrigger value="raw">Raw JSON</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
