import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";

export function formatCodexResetCredits(
  value: number | null | undefined,
): string {
  if (value === null || value === undefined) {
    return "Resets left unavailable";
  }
  return `${value} ${value === 1 ? "reset" : "resets"} left`;
}

export function CodexResetUsageDialog({
  open,
  resetCredits,
  resetting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  resetCredits: number | null;
  resetting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!resetting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset Codex usage?</DialogTitle>
          <DialogDescription>
            Use one Codex reset to reset your current usage windows. You have{" "}
            {formatCodexResetCredits(resetCredits)}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={resetting}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={resetting || resetCredits === 0}
            onClick={onConfirm}
          >
            {resetting ? "Resetting..." : "Reset usage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
