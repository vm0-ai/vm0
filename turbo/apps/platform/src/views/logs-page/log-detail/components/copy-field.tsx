import { CopyButton } from "@vm0/ui";

export function CopyField({ text }: { text: string }) {
  return (
    <div className="flex h-9 max-w-full items-center gap-2 rounded-md bg-muted px-3">
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-foreground">
        {text}
      </span>
      <CopyButton text={text} className="h-4 w-4 shrink-0 p-0" />
    </div>
  );
}
