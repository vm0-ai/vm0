import { useGet, useSet, useLastResolved, useLoadable } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { IconTrash } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";

import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ClaudeCodeSetupPrompt } from "./setup-prompt.tsx";
import {
  cancelSettingsEdit$,
  deleteOAuthToken$,
  hasClaudeCodeOauthToken$,
  isEditingClaudeCodeOauthToken$,
  claudeCodeOauthTokenPlaceholder$,
  saveClaudeCodeOauthToken$,
  updateClaudeCodeOauthTokenValue$,
  claudeCodeOauthTokenValue$,
  startEditing$,
  actionPromise$,
} from "../../signals/settings-page/model-providers.ts";

export function SettingsPage() {
  return (
    <AppShell
      breadcrumb={["Settings"]}
      title="Settings"
      subtitle="Your project settings"
    >
      <div className="flex flex-col gap-6 px-8 pb-8">
        <ClaudeCodeOAuthTokenCard />
      </div>
    </AppShell>
  );
}

function ClaudeCodeOAuthTokenCard() {
  const tokenValue = useGet(claudeCodeOauthTokenValue$);
  const setTokenValue = useSet(updateClaudeCodeOauthTokenValue$);
  const isEditing = useGet(isEditingClaudeCodeOauthToken$);
  const setIsEditing = useSet(startEditing$);
  const saveProvider = useSet(saveClaudeCodeOauthToken$);
  const cancelEdit = useSet(cancelSettingsEdit$);
  const placeholder = useLastResolved(claudeCodeOauthTokenPlaceholder$);
  const hasToken = useLastResolved(hasClaudeCodeOauthToken$);
  const deleteToken = useSet(deleteOAuthToken$);
  const pageSignal = useGet(pageSignal$);
  const actionStatus = useLoadable(actionPromise$);

  const handleSave = () => {
    detach(saveProvider(pageSignal), Reason.DomCallback);
  };

  const handleCancel = () => {
    cancelEdit();
  };

  const handleDelete = () => {
    detach(deleteToken(pageSignal), Reason.DomCallback);
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-medium text-foreground">
            Manage your model provider
          </h3>
          <p className="text-sm text-muted-foreground">
            An OAuth token is required to run Claude Code in sandboxes.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            Claude Code OAuth token
          </label>

          <div className="flex gap-2">
            <Input
              value={tokenValue}
              placeholder={
                actionStatus.state === "loading" ? "Saving..." : placeholder
              }
              onChange={(e) => setTokenValue(e.target.value)}
              readOnly={actionStatus.state === "loading"}
              onFocus={() => {
                detach(setIsEditing(pageSignal), Reason.DomCallback);
              }}
            />
            {actionStatus.state !== "loading" && hasToken && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDelete}
                aria-label="Delete Claude Code OAuth token"
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <IconTrash className="h-4 w-4" />
              </Button>
            )}
          </div>
          <ClaudeCodeSetupPrompt />
        </div>

        {isEditing && (
          <div className="flex gap-2">
            <Button
              onClick={handleSave}
              disabled={!tokenValue && isEditing}
              size="sm"
            >
              Save
            </Button>
            <Button variant="outline" onClick={handleCancel} size="sm">
              Cancel
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
