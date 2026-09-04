import { createPortal } from "react-dom";
import { Pencil, Loader2 } from "lucide-react";
import { Button } from "@okouai/ui";

interface UnsavedBarProps {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  message?: string;
  discardLabel?: string;
  saveLabel?: string;
}

export function UnsavedBar({
  onDiscard,
  onSave,
  saving,
  message = "You have unsaved changes",
  discardLabel = "Discard",
  saveLabel = "Save",
}: UnsavedBarProps) {
  const bar = (
    <div className="zero-app fixed bottom-[max(1.5rem,var(--sab))] left-0 right-0 z-40 flex justify-center px-4">
      <div
        data-testid="unsaved-bar"
        className="zero-card flex max-w-md items-center justify-between gap-4 px-5 py-4 shadow-lg"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Pencil size={18} className="shrink-0" />
          <span>{message}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            data-testid="discard-button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onDiscard}
            disabled={saving}
          >
            {discardLabel}
          </Button>
          <Button
            data-testid="save-button"
            size="sm"
            className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary-hover"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? (
              <Loader2
                data-testid="save-spinner"
                size={14}
                className="animate-spin mr-1.5"
              />
            ) : null}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
  // Keep this app-local notice inside the isolated app stack. Modal and
  // floating Base UI portals live outside it and therefore stay above it
  // without coordinating z-index values with this component.
  const appRoot =
    typeof document === "undefined" ? null : document.getElementById("root");
  return appRoot ? createPortal(bar, appRoot) : bar;
}
