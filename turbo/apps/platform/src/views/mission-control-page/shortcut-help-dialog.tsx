import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  getShortcutLabel,
} from "@vm0/ui";

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Available shortcuts in Mission Control
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ShortcutSection
            title="Global"
            shortcuts={[
              { key: "j", label: "Next task" },
              { key: "k", label: "Previous task" },
              { key: "mod+b", label: "Toggle task list" },
              { key: "c", label: "New chat" },
              { key: "y", label: "Archive task" },
              { key: "shift+?", label: "Show shortcuts" },
            ]}
          />
          <ShortcutSection
            title="Task Card"
            shortcuts={[
              { key: "enter", label: "Open task" },
              { key: "space", label: "Toggle panel" },
            ]}
          />
          <ShortcutSection
            title="Task Panel"
            shortcuts={[
              { key: "mod+shift+enter", label: "Maximize / restore" },
              { key: "escape", label: "Back to task card" },
              { key: "ctrl+d", label: "Close panel" },
            ]}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutSection({
  title,
  shortcuts,
}: {
  title: string;
  shortcuts: { key: string; label: string }[];
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {title}
      </h3>
      <div className="space-y-1">
        {shortcuts.map((shortcut) => {
          return (
            <div
              key={shortcut.key}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm">{shortcut.label}</span>
              <kbd className="ml-4 shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                {getShortcutLabel(shortcut.key)}
              </kbd>
            </div>
          );
        })}
      </div>
    </div>
  );
}
