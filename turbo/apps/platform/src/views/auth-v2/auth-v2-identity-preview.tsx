import { Button } from "@okouai/ui";
import { Pencil } from "lucide-react";

export function AuthV2IdentityPreview({
  actionLabel,
  onEdit,
  value,
}: {
  readonly actionLabel: string;
  readonly onEdit: () => void;
  readonly value: string;
}) {
  return (
    <div className="flex h-5 w-full items-center justify-center gap-2 text-sm leading-5 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate text-center">{value}</span>
      <Button
        aria-label={actionLabel}
        className="relative size-4 shrink-0 rounded-sm p-0 text-muted-foreground after:absolute after:-inset-1"
        size="icon-2xs"
        type="button"
        variant="ghost"
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
