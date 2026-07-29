import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";

export function CustomConnectorUpdateConfirm({
  submitting,
  onCancel,
  onConfirm,
}: {
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onCancel();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Disconnect existing OAuth connections?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          These OAuth changes will disconnect every member currently connected
          with OAuth. They&apos;ll need to connect this custom connector again.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Save and disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
