// Mobile-native iOS Settings-style rows for the Workspace > General tab.
// Desktop continues to render the inline-input layout from org-general-tab;
// these components only show below `md:` and trigger bottom-sheet edits that
// commit per-field on tap (instead of the desktop batch "Save changes" bar).

import type { ReactNode } from "react";
import { IconChevronRight, IconUpload } from "@tabler/icons-react";
import {
  cn,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@vm0/ui";
import { onDomEventFn } from "../../../../signals/utils.ts";

interface MobileFieldEditSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  // Controlled draft state owned by the parent — `useState` is restricted in
  // this codebase, so the draft lives in a ccstate signal.
  readonly draft: string;
  readonly onDraftChange: (next: string) => void;
  readonly initialValue: string;
  readonly saving: boolean;
  readonly errorMessage: string | null;
  // Returns true if the save succeeded — sheet closes only on success so
  // failures keep the user in the editor with the value they typed.
  readonly onSave: (next: string) => Promise<boolean>;
}

export function MobileFieldEditSheet({
  open,
  onOpenChange,
  label,
  description,
  placeholder,
  draft,
  onDraftChange,
  initialValue,
  saving,
  errorMessage,
  onSave,
}: MobileFieldEditSheetProps) {
  const dirty = draft !== initialValue;

  const handleClose = () => {
    if (saving) {
      return;
    }
    onOpenChange(false);
  };

  const handleSave = async () => {
    if (!dirty || saving) {
      return;
    }
    const ok = await onSave(draft);
    if (ok) {
      onOpenChange(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        hideClose
        className="rounded-t-2xl p-0 shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_-16px_48px_-12px_rgba(0,0,0,0.55)]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Edit {label}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        {/* Grabber */}
        <div className="flex justify-center pt-2.5">
          <span
            aria-hidden
            className="h-1 w-10 rounded-full bg-[hsl(var(--gray-300))]"
          />
        </div>

        {/* Header bar: Cancel · title · Save */}
        <div className="grid grid-cols-3 items-center px-3 pt-2 pb-3 border-b border-border/60">
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="justify-self-start text-[16px] text-primary px-2 py-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <span className="justify-self-center text-[16px] font-semibold text-foreground">
            {label}
          </span>
          <button
            type="button"
            onClick={onDomEventFn(handleSave)}
            disabled={!dirty || saving}
            className={cn(
              "justify-self-end text-[16px] font-semibold px-2 py-1",
              dirty && !saving
                ? "text-primary"
                : "text-muted-foreground/50",
            )}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        <div className="flex flex-col gap-2 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <Input
            value={draft}
            onChange={(e) => {
              onDraftChange(e.target.value);
            }}
            placeholder={placeholder}
            autoFocus
            disabled={saving}
            className="h-12 text-[16px]"
          />
          <p className="text-[13px] text-muted-foreground leading-snug px-1">
            {description}
          </p>
          {errorMessage && (
            <p className="text-[13px] text-destructive px-1">{errorMessage}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface MobileFieldRowProps {
  readonly label: string;
  readonly value: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export function MobileFieldRow({
  label,
  value,
  onClick,
  disabled,
}: MobileFieldRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors active:bg-muted/40 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <span className="text-[16px] font-medium text-foreground shrink-0">
        {label}
      </span>
      <span className="flex items-center gap-1 min-w-0">
        <span className="text-[16px] text-muted-foreground truncate">
          {value || "—"}
        </span>
        <IconChevronRight
          size={18}
          stroke={1.5}
          className="shrink-0 text-muted-foreground/60"
        />
      </span>
    </button>
  );
}

interface MobileLogoRowProps {
  readonly logoSrc: string | null;
  readonly slug: string | null | undefined;
  readonly onPick: () => void;
  readonly canEdit: boolean;
}

export function MobileLogoRow({
  logoSrc,
  slug,
  onPick,
  canEdit,
}: MobileLogoRowProps) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!canEdit}
      className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors active:bg-muted/40 disabled:opacity-100 disabled:cursor-default"
    >
      <span className="text-[16px] font-medium text-foreground">Logo</span>
      <span className="flex items-center gap-2">
        <span className="relative h-9 w-9 shrink-0 rounded-lg overflow-hidden bg-muted/40">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={slug ?? "Workspace logo"}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full bg-muted/50 animate-pulse" />
          )}
          {canEdit && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/30">
              <IconUpload size={12} stroke={2} className="text-white" />
            </span>
          )}
        </span>
        {canEdit && (
          <IconChevronRight
            size={18}
            stroke={1.5}
            className="shrink-0 text-muted-foreground/60"
          />
        )}
      </span>
    </button>
  );
}

interface MobileDestructiveRowProps {
  readonly label: string;
  readonly onClick: () => void;
}

export function MobileDestructiveRow({
  label,
  onClick,
}: MobileDestructiveRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors active:bg-destructive/10"
    >
      <span className="text-[16px] font-medium text-destructive">{label}</span>
      <IconChevronRight
        size={18}
        stroke={1.5}
        className="shrink-0 text-destructive/60"
      />
    </button>
  );
}

interface MobileSectionFooterProps {
  readonly children: ReactNode;
}

export function MobileSectionFooter({ children }: MobileSectionFooterProps) {
  // iOS-style footnote — tiny muted copy below the grouped card. Carries the
  // helper text that, on desktop, lives inside each row.
  return (
    <p className="px-5 pt-1.5 text-[13px] text-muted-foreground leading-snug">
      {children}
    </p>
  );
}

