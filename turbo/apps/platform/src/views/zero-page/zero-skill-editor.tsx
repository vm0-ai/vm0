import { useGet, useSet } from "ccstate-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Button,
} from "@vm0/ui";
import {
  editorMode$,
  editorDraft$,
  editorOriginal$,
  editorSaving$,
  editorError$,
  editorLoading$,
  editorDirty$,
  setEditorDraft$,
  closeEditor$,
  submitEditor$,
} from "../../signals/skills-page/skill-editor.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { TiptapInstructionsEditor } from "./tiptap-instructions-editor.tsx";

const NAME_MIN = 2;
const NAME_MAX = 64;
const DISPLAY_NAME_MAX = 256;
const DESCRIPTION_MAX = 1024;

function validateName(name: string): string | null {
  if (name.length < NAME_MIN) {
    return `Must be at least ${String(NAME_MIN)} characters`;
  }
  if (name.length > NAME_MAX) {
    return `Must be at most ${String(NAME_MAX)} characters`;
  }
  // Mirrors zeroAgentCustomSkillNameSchema — lowercase letters/digits/hyphens,
  // no leading/trailing hyphen.
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
    return "Lowercase letters, digits, and hyphens only (no leading/trailing hyphen)";
  }
  return null;
}

export function ZeroSkillEditor() {
  const mode = useGet(editorMode$);
  const saving = useGet(editorSaving$);
  const close = useSet(closeEditor$);
  const open = mode.kind !== "closed";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) {
          close();
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-full sm:max-w-[640px] flex flex-col"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
        }}
      >
        {open && <EditorBody />}
      </SheetContent>
    </Sheet>
  );
}

function EditorBody() {
  const mode = useGet(editorMode$);
  const draft = useGet(editorDraft$);
  const original = useGet(editorOriginal$);
  const saving = useGet(editorSaving$);
  const error = useGet(editorError$);
  const loading = useGet(editorLoading$);
  const dirty = useGet(editorDirty$);
  const setDraft = useSet(setEditorDraft$);
  const close = useSet(closeEditor$);
  const submit = useSet(submitEditor$);
  const signal = useGet(pageSignal$);

  const isCreate = mode.kind === "create";
  const nameError =
    isCreate && draft.name !== "" ? validateName(draft.name) : null;

  const canSubmit =
    !saving &&
    !loading &&
    dirty &&
    (isCreate ? draft.name !== "" && nameError === null : true) &&
    draft.content.trim() !== "";

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    detach(submit(signal), Reason.DomCallback, "submit-skill-editor");
  };

  const editorKey =
    mode.kind === "edit"
      ? `edit:${mode.name}:${original ? "loaded" : "loading"}`
      : "create";

  return (
    <>
      <SheetHeader className="shrink-0">
        <SheetTitle>{isCreate ? "New skill" : "Edit skill"}</SheetTitle>
        <SheetDescription>
          {isCreate
            ? "Define a reusable skill. Agents can opt in from the Skills tab."
            : "Edit SKILL.md and metadata. Other files are managed via the CLI."}
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
        {loading ? (
          <EditorSkeleton />
        ) : (
          <EditorForm
            draft={draft}
            isCreate={isCreate}
            saving={saving}
            nameError={nameError}
            error={error}
            otherFiles={original?.otherFiles ?? null}
            editorKey={editorKey}
            setDraft={setDraft}
          />
        )}
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 pt-4 border-t border-border/60">
        <Button
          variant="outline"
          onClick={() => {
            close();
          }}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={!canSubmit}>
          {saving ? "Saving…" : isCreate ? "Create skill" : "Save changes"}
        </Button>
      </div>
    </>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-3 animate-pulse pt-4">
      <div className="h-9 w-full rounded bg-muted/30" />
      <div className="h-9 w-full rounded bg-muted/30" />
      <div className="h-32 w-full rounded bg-muted/30" />
    </div>
  );
}

interface EditorFormProps {
  draft: {
    name: string;
    displayName: string;
    description: string;
    content: string;
  };
  isCreate: boolean;
  saving: boolean;
  nameError: string | null;
  error: string | null;
  otherFiles: { path: string; size: number }[] | null;
  editorKey: string;
  setDraft: (
    patch: Partial<{
      name: string;
      displayName: string;
      description: string;
      content: string;
    }>,
  ) => void;
}

function EditorForm({
  draft,
  isCreate,
  saving,
  nameError,
  error,
  otherFiles,
  editorKey,
  setDraft,
}: EditorFormProps) {
  return (
    <div className="flex flex-col gap-4 pt-4">
      <Field
        label="Name"
        hint="Lowercase, digits, hyphens. Used as the skill identifier."
      >
        <input
          type="text"
          value={draft.name}
          onChange={(e) => {
            setDraft({ name: e.target.value });
          }}
          disabled={!isCreate || saving}
          placeholder="e.g. release-notes"
          className="h-9 w-full rounded-md border border-border bg-input px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:opacity-60"
          maxLength={NAME_MAX}
        />
        {nameError && (
          <p className="text-xs text-destructive mt-1">{nameError}</p>
        )}
      </Field>

      <Field label="Display name" hint="Optional human-readable label.">
        <input
          type="text"
          value={draft.displayName}
          onChange={(e) => {
            setDraft({ displayName: e.target.value });
          }}
          disabled={saving}
          placeholder="e.g. Release Notes"
          className="h-9 w-full rounded-md border border-border bg-input px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:opacity-60"
          maxLength={DISPLAY_NAME_MAX}
        />
      </Field>

      <Field
        label="Description"
        hint="Optional one-liner shown in the agent Skills tab."
      >
        <input
          type="text"
          value={draft.description}
          onChange={(e) => {
            setDraft({ description: e.target.value });
          }}
          disabled={saving}
          placeholder="What does this skill do?"
          className="h-9 w-full rounded-md border border-border bg-input px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:opacity-60"
          maxLength={DESCRIPTION_MAX}
        />
      </Field>

      <Field label="SKILL.md">
        <TiptapInstructionsEditor
          key={editorKey}
          initialContent={draft.content}
          onChange={(value) => {
            setDraft({ content: value });
          }}
          disabled={saving}
          footerHint="The instructions an agent sees when this skill is enabled."
        />
      </Field>

      {otherFiles && otherFiles.length > 0 && (
        <Field
          label="Other files"
          hint="Managed via the CLI. Saving here only updates SKILL.md and metadata."
        >
          <ul className="rounded-md border border-border/60 bg-muted/20 divide-y divide-border/40">
            {otherFiles.map((file) => {
              return (
                <li
                  key={file.path}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                >
                  <span className="font-mono text-foreground truncate">
                    {file.path}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {formatBytes(file.size)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Field>
      )}

      {error && <p className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
