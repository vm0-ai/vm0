import { useGet, useSet, useLastResolved, useLoadable } from "ccstate-react";
import { Card } from "@vm0/ui/components/ui/card";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { IconX, IconLock, IconInfoCircle } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";

import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ClaudeCodeSetupPrompt } from "./setup-prompt.tsx";
import {
  cancelSettingsEdit$,
  deleteOAuthToken$,
  hasClaudeCodeOauthToken$,
  isEditingClaudeCodeOauthToken$,
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
      subtitle="Configure your model providers and project preferences"
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
  const hasToken = useLastResolved(hasClaudeCodeOauthToken$);
  const deleteToken = useSet(deleteOAuthToken$);
  const pageSignal = useGet(pageSignal$);
  const actionStatus = useLoadable(actionPromise$);

  // Show masked token when user has token and is not editing
  const displayValue =
    !isEditing && hasToken && !tokenValue
      ? "sk-ant-oat-••••••••••••••••"
      : tokenValue;

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
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
            Claude Code OAuth token
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="inline-flex">
                    <IconInfoCircle className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">
                  <p className="text-xs">
                    Your token is encrypted and securely stored. It will only be
                    used for sandboxed execution and never shared with third
                    parties.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </label>

          <div className="flex gap-2">
            <div className="relative flex items-center flex-1">
              <IconLock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={displayValue}
                placeholder={
                  isEditing && hasToken
                    ? "Update your Claude Code OAuth token"
                    : "sk-ant-oat..."
                }
                onChange={(e) => setTokenValue(e.target.value)}
                readOnly={actionStatus.state === "loading"}
                onFocus={() => {
                  detach(setIsEditing(pageSignal), Reason.DomCallback);
                }}
                className="pl-9 font-mono"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              />
            </div>
            {actionStatus.state !== "loading" && hasToken && (
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleDelete}
                      aria-label="Clear token"
                      className="icon-button shrink-0"
                    >
                      <IconX className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Clear token</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
