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
    <div className="flex min-h-6 w-full items-center justify-center gap-2 text-sm leading-5 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate text-center">{value}</span>
      <Button
        showTooltip
        aria-label={actionLabel}
        size="icon-2xs"
        type="button"
        variant="quiet"
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" />
      </Button>
    </div>
  );
}
