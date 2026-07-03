import { createPortal } from "react-dom";
import { IconPencil, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@vm0/ui";

interface ZeroUnsavedBarProps {
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
}

export function ZeroUnsavedBar({
  onDiscard,
  onSave,
  saving,
}: ZeroUnsavedBarProps) {
  return createPortal(
    <div className="zero-app fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4">
      <div
        data-testid="unsaved-bar"
        className="zero-card flex max-w-md items-center justify-between gap-4 px-5 py-4 shadow-lg"
      >
        <div className="flex items-center gap-2 text-sm text-foreground">
          <IconPencil
            size={18}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
          <span>You have unsaved changes</span>
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
            Discard
          </Button>
          <Button
            data-testid="save-button"
            size="sm"
            className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? (
              <IconLoader2
                data-testid="save-spinner"
                size={14}
                stroke={1.5}
                className="animate-spin mr-1.5"
              />
            ) : null}
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
