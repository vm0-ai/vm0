import { useGet } from "ccstate-react";
import { AppShell } from "../../layout/app-shell.tsx";
import { currentLogId$ } from "../../../signals/logs-page/log-detail-state.ts";
import { LogDetailContent } from "./components/log-detail-content.tsx";
import { SecretDialog } from "../../settings-page/secret-dialog.tsx";

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
          <LogDetailContent />
        ) : (
          <div className="p-8 text-center text-muted-foreground">
            Can&apos;t find that run
          </div>
        )}
      </div>
      <SecretDialog />
    </AppShell>
  );
}
