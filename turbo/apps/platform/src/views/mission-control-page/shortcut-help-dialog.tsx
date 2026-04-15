import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  getShortcutParts,
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
              { key: "shift+?", label: "Show shortcuts" },
              { key: "j", label: "Next task" },
              { key: "k", label: "Previous task" },
              { key: "mod+b", label: "Toggle task list" },
              { key: "c", label: "New chat" },
              { key: "y", label: "Archive task" },
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
      <h3 className="text-xs font-medium text-muted-foreground tracking-wide mb-2">
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
              <div className="ml-4 shrink-0 flex items-center gap-1">
                {getShortcutParts(shortcut.key).map((part) => {
                  return (
                    <kbd
                      key={part}
                      className="inline-flex items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground min-w-[1.5rem]"
                    >
                      {part}
                    </kbd>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
