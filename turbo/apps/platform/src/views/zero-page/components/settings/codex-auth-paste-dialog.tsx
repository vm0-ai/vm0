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

type CodexPasteScope = "org" | "personal";

/**
 * Paste-based connection dialog for the codex-oauth-token provider.
 *
 * Replaces the broken cross-origin `window.location.assign` redirect that
 * shipped in #11909. Same component handles first-time connect and re-paste
 * recovery from a stale session — only the title differs by mode. The
 * `scope` prop selects between org-tier (`/api/zero/model-providers`) and
 * personal-tier (`/api/zero/me/model-providers`) signal bundles so a single
 * UI component drives both contexts (#12024).
 *
 * Submit POSTs `{ type: 'codex-oauth-token', authMethod: 'auth_json',
 * secrets: { CODEX_AUTH_JSON: <raw> } }` to the scope-appropriate endpoint.
 * Typed error codes (`CODEX_AUTH_JSON_SHAPE_INVALID`,
 * `CODEX_FREE_PLAN_REJECTED`) surface inline rather than via toast — the
 * user is staring at the textarea, an inline message keeps cause-and-effect
 * close.
 */
export function CodexAuthPasteDialog({
  scope = "org",
}: {
  scope?: CodexPasteScope;
}) {
  // Both bundles must be subscribed unconditionally to keep hook order
  // stable; the unused side is read but its value isn't acted on.
  const orgDialog = useGet(codexPasteDialogState$);
  const orgPaste = useGet(codexPasteContent$);
  const personalDialog = useGet(codexPasteDialogStatePersonal$);
  const personalPaste = useGet(codexPasteContentPersonal$);
  const setOrgDialog = useSet(setCodexPasteDialogState$);
  const updateOrgPaste = useSet(updateCodexPasteContent$);
  const setPersonalDialog = useSet(setCodexPasteDialogStatePersonal$);
  const updatePersonalPaste = useSet(updateCodexPasteContentPersonal$);
  const pageSignal = useGet(pageSignal$);
  const [orgSubmitLoadable, orgSubmit] = useLoadableSet(submitCodexAuthJson$);
  const [personalSubmitLoadable, personalSubmit] = useLoadableSet(
    submitCodexAuthJsonPersonal$,
  );

  const dialog = scope === "personal" ? personalDialog : orgDialog;
  const paste = scope === "personal" ? personalPaste : orgPaste;
  const setDialog = scope === "personal" ? setPersonalDialog : setOrgDialog;
  const updatePaste =
    scope === "personal" ? updatePersonalPaste : updateOrgPaste;
  const submitLoadable =
    scope === "personal" ? personalSubmitLoadable : orgSubmitLoadable;
  const submit = scope === "personal" ? personalSubmit : orgSubmit;

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
