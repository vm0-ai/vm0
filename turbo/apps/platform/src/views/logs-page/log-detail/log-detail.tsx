import { useGet } from "ccstate-react";
import { AppShell } from "../../layout/app-shell.tsx";
import { currentLogId$ } from "../../../signals/logs-page/log-detail-state.ts";
import { LogDetailContent } from "./components/log-detail-content.tsx";

export function LogDetailPage() {
  const logId = useGet(currentLogId$);

  const breadcrumb = [
    { label: "Logs", path: "/logs" as const },
    { label: logId ? `Run ID - ${logId}` : "Detail" },
  ];

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="h-full flex flex-col">
        {logId ? (
          <LogDetailContent logId={logId} />
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            Log ID not found
          </div>
        )}
      </div>
    </AppShell>
  );
}
