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
      <div className="px-8">
        {/* Search */}
        <div className="mt-4">
          <LogsSearch />
        </div>

        {/* Logs Table */}
        <div className="mt-4">
          <LogsTable />
        </div>

        {/* Pagination Controls */}
        <LogsPagination />
      </div>
    </AppShell>
  );
}
