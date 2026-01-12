import { AppShell } from "../layout/app-shell.tsx";

export function LogsPage() {
  return (
    <AppShell
      breadcrumb={["Logs"]}
      title="Logs"
      subtitle="Logs include agent, system metrics and network, identified by run ID."
    >
      <div className="px-8">
        {/* Placeholder for logs table */}
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          Logs table will be implemented here.
        </div>
      </div>
    </AppShell>
  );
}
