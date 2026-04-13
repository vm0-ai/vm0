import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { toast } from "@vm0/ui/components/ui/sonner";
import { deleteSkill$ } from "../../signals/skills-page/skill-delete.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason, throwIfAbort } from "../../signals/utils.ts";

export function ZeroSkillDeleteConfirm({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const [deleteLoadable, deleteSkill] = useLoadableSet(deleteSkill$);
  const signal = useGet(pageSignal$);
  const deleting = deleteLoadable.state === "loading";

  const onConfirm = () => {
    detach(
      deleteSkill(name, signal).then(
        () => {
          toast.success(`Skill "${name}" deleted`);
          onClose();
        },
        (error: unknown) => {
          throwIfAbort(error);
          const message =
            error instanceof Error ? error.message : "Delete failed";
          toast.error(`Failed to delete skill: ${message}`);
        },
      ),
      Reason.DomCallback,
      "delete-skill",
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete skill?</DialogTitle>
          <DialogDescription>
            This will permanently delete{" "}
            <span className="font-mono text-foreground">{name}</span> and unbind
            it from any agents currently using it. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
