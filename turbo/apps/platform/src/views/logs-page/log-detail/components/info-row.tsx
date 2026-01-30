export function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="text-sm text-muted-foreground w-24 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}
