export function LogsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
      <p className="text-lg">No runs found</p>
      <p className="text-sm mt-2">
        Runs will appear here once you execute agents.
      </p>
    </div>
  );
}
