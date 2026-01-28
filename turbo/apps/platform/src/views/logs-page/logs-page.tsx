import { AppShell } from "../layout/app-shell.tsx";
import { LogsTable } from "./logs-table.tsx";
import { LogsPagination } from "./logs-pagination.tsx";
import { LogsSearch } from "./logs-search.tsx";

export function LogsPage() {
  return (
    <AppShell
      breadcrumb={["Logs"]}
      title="Logs"
      subtitle="View all agent runs and execution history."
    >
      <div className="flex flex-col gap-6 px-6 mb-8">
        {/* Search */}
        <LogsSearch />

        {/* Logs Table */}
        <LogsTable />

        {/* Pagination Controls */}
        <LogsPagination />
      </div>
    </AppShell>
  );
}
