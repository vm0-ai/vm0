/**
 * Small metadata pill rendered next to a connector's "Connected" status
 * when the connection is provided by VM0's hosted key (usage is billed to
 * org credits) rather than a user-supplied credential.
 */
export function Vm0ManagedBadge() {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      VM0 Managed
    </span>
  );
}
