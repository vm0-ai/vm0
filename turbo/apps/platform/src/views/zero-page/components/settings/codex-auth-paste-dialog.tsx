import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import {
  codexPasteContent$,
  codexPasteDialogState$,
  setCodexPasteDialogState$,
  submitCodexAuthJson$,
  updateCodexPasteContent$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import {
  codexPasteContentPersonal$,
  codexPasteDialogStatePersonal$,
  setCodexPasteDialogStatePersonal$,
  submitCodexAuthJsonPersonal$,
  updateCodexPasteContentPersonal$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import { ApiError } from "../../../../lib/accept.ts";
import { detach, isValidJson, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

type CodexPasteDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

/**
 * Loadable state read by the dialog. Derived from `useLoadableSet`'s actual
 * return tuple so the discriminator union here cannot drift from
 * `ccstate-react/experimental` — if the upstream library renames/adds a
 * state, this type updates with it. `unknown` for the data type because the
 * dialog only inspects `state` and `error` (both org and personal commands
 * resolve to a non-void payload, and we don't want the bundle interface to
 * bake one scope's payload into the other's signature).
 */
type SubmitLoadable = ReturnType<
  typeof useLoadableSet<unknown, [AbortSignal]>
>[0];

/**
 * The set of signals the paste dialog reads/writes for one scope. Both the
 * org and personal variants conform to this shape, so the inner presentational
 * `CodexAuthPasteDialogView` can be agnostic of which scope it is rendering
 * — only the wrapper (`Org…` / `Personal…`) subscribes to the right bundle.
 */
interface CodexPasteScopeBundle {
  dialog: CodexPasteDialogState;
  paste: string;
  setDialog: (next: CodexPasteDialogState) => void;
  updatePaste: (next: string) => void;
  submitLoadable: SubmitLoadable;
  submit: (signal: AbortSignal) => Promise<unknown>;
}

/**
 * Org-tier wrapper. Subscribes only to the org signal bundle so the personal
 * bundle is not evaluated on this render path. Used from `org-providers-tab`.
 */
export function CodexAuthPasteDialog() {
  const bundle = useOrgCodexPasteBundle();
  return <CodexAuthPasteDialogView bundle={bundle} />;
}

/**
 * Personal-tier wrapper. Subscribes only to the personal signal bundle so
 * the org bundle is not evaluated on this render path. Used from
 * `personal-providers-tab`.
 */
export function PersonalCodexAuthPasteDialog() {
  const bundle = usePersonalCodexPasteBundle();
  return <CodexAuthPasteDialogView bundle={bundle} />;
}

function useOrgCodexPasteBundle(): CodexPasteScopeBundle {
  const dialog = useGet(codexPasteDialogState$);
  const paste = useGet(codexPasteContent$);
  const setDialog = useSet(setCodexPasteDialogState$);
  const updatePaste = useSet(updateCodexPasteContent$);
  const [submitLoadable, submit] = useLoadableSet(submitCodexAuthJson$);
  return { dialog, paste, setDialog, updatePaste, submitLoadable, submit };
}

function usePersonalCodexPasteBundle(): CodexPasteScopeBundle {
  const dialog = useGet(codexPasteDialogStatePersonal$);
  const paste = useGet(codexPasteContentPersonal$);
  const setDialog = useSet(setCodexPasteDialogStatePersonal$);
  const updatePaste = useSet(updateCodexPasteContentPersonal$);
  const [submitLoadable, submit] = useLoadableSet(submitCodexAuthJsonPersonal$);
  return { dialog, paste, setDialog, updatePaste, submitLoadable, submit };
}

/**
 * Paste-based connection dialog for the codex-oauth-token provider.
 *
 * Replaces the broken cross-origin `window.location.assign` redirect that
 * shipped in #11909. Same component handles first-time connect and re-paste
 * recovery from a stale session — only the title differs by mode. The
 * scope-specific signal bundle is supplied by the wrapper component so this
 * presentational layer is agnostic of org vs personal tier (#12024).
 *
 * Submit POSTs `{ type: 'codex-oauth-token', authMethod: 'auth_json',
 * secrets: { CODEX_AUTH_JSON: <raw> } }` to the scope-appropriate endpoint.
 * Typed error codes (`CODEX_AUTH_JSON_SHAPE_INVALID`,
 * `CODEX_FREE_PLAN_REJECTED`) surface inline rather than via toast — the
 * user is staring at the textarea, an inline message keeps cause-and-effect
 * close.
 */
function CodexAuthPasteDialogView({
  bundle,
}: {
  bundle: CodexPasteScopeBundle;
}) {
  const { dialog, paste, setDialog, updatePaste, submitLoadable, submit } =
    bundle;
  const pageSignal = useGet(pageSignal$);

  const submitting = submitLoadable.state === "loading";
  const serverError =
    submitLoadable.state === "hasError" &&
    submitLoadable.error instanceof ApiError
      ? submitLoadable.error
      : null;

  const trimmed = paste.trim();
  const localParseError = computeLocalParseError(trimmed);
  const canSubmit = trimmed !== "" && localParseError === null && !submitting;

  function handleOpenChange(nextOpen: boolean): void {
    setDialog({ ...dialog, open: nextOpen });
  }

  const title =
    dialog.mode === "reconnect" ? "Re-connect Codex" : "Connect Codex";
  const submitLabel = submitting
    ? "Connecting…"
    : dialog.mode === "reconnect"
      ? "Reconnect"
      : "Connect";

  return (
    <Dialog open={dialog.open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Paste the contents of <code>~/.codex/auth.json</code> from the
            machine where you ran <code>codex login</code>.
          </DialogDescription>
        </DialogHeader>

        <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
          <li>
            On your local machine, run <code>codex login</code>
          </li>
          <li>
            After successful login, run <code>cat ~/.codex/auth.json</code>
          </li>
          <li>Paste the entire JSON output below</li>
        </ol>

        <textarea
          value={paste}
          onChange={(e) => {
            return updatePaste(e.target.value);
          }}
          placeholder='{"OPENAI_API_KEY": "...", "tokens": {...}, ...}'
          rows={8}
          spellCheck={false}
          aria-label="codex auth.json content"
          data-testid="codex-paste-textarea"
          className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-xs font-mono whitespace-pre text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[10rem]"
        />

        {localParseError && (
          <p className="text-xs text-muted-foreground">{localParseError}</p>
        )}
        {serverError && (
          <p className="text-xs text-destructive" role="alert">
            {getErrorCopy(serverError)}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              return handleOpenChange(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              detach(submit(pageSignal), Reason.DomCallback);
            }}
            disabled={!canSubmit}
            data-testid="codex-paste-submit"
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computeLocalParseError(trimmed: string): string | null {
  if (trimmed === "") {
    return null;
  }
  return isValidJson(trimmed)
    ? null
    : "Looks like the paste isn't valid JSON yet.";
}

function getErrorCopy(error: ApiError): string {
  if (error.code === "CODEX_AUTH_JSON_SHAPE_INVALID") {
    return "auth.json format unrecognized — your codex CLI may need updating. Re-run `codex login` and try again.";
  }
  if (error.code === "CODEX_FREE_PLAN_REJECTED") {
    return "Free ChatGPT plans cannot use Codex via vm0. Upgrade to Plus or Pro and re-run `codex login`.";
  }
  return error.message;
}
