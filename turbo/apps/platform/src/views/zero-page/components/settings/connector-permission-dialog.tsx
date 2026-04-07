import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconSearch, IconCircleCheckFilled } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { agents$ } from "../../../../signals/zero-page/agents-list.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { resolveAvatarUrl } from "../../avatar-utils.ts";
import { ZERO_AVATARS } from "../../zero-avatars.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import {
  permissionDialogSelected$,
  togglePermissionDialogAgent$,
  permissionDialogSearch$,
  setPermissionDialogSearch$,
  confirmPermissionDialog$,
} from "../../../../signals/zero-page/settings/permission-dialog.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";

const VISIBLE_AGENT_COUNT = 16;

interface ConnectorPermissionDialogProps {
  connectorType: ConnectorType;
  onClose: () => void;
}

export function ConnectorPermissionDialog({
  connectorType,
  onClose,
}: ConnectorPermissionDialogProps) {
  const allAgents = useLastResolved(agents$);
  const selected = useGet(permissionDialogSelected$);
  const toggle = useSet(togglePermissionDialogAgent$);
  const search = useGet(permissionDialogSearch$);
  const setSearch = useSet(setPermissionDialogSearch$);
  const [confirmLoadable, confirm] = useLoadableSet(confirmPermissionDialog$);
  const pageSignal = useGet(pageSignal$);

  const submitting = confirmLoadable.state === "loading";

  const config = CONNECTOR_TYPES[connectorType];

  const filtered = (() => {
    if (!allAgents) {
      return [];
    }
    if (!search) {
      return allAgents;
    }
    const q = search.toLowerCase();
    return allAgents.filter((a) => {
      return a.displayName?.toLowerCase().includes(q) ?? false;
    });
  })();

  const visibleAgents = filtered.slice(0, VISIBLE_AGENT_COUNT);
  const remainingCount = filtered.length - VISIBLE_AGENT_COUNT;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-w-[620px] flex-col gap-4 px-6 pb-6 pt-6">
        <DialogHeader className="mt-5 items-center gap-2.5 text-center">
          <div className="flex items-center justify-center rounded-[10px] bg-[#f3f5f8] p-2.5">
            <ConnectorIcon type={connectorType} size={20} />
          </div>
          <DialogTitle className="text-base font-medium">
            {config.label}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-10">
          <div className="flex flex-col gap-5">
            {/* Header text + Search */}
            <div className="flex flex-col items-center gap-6">
              <div className="flex flex-col items-center gap-2.5 text-center text-foreground">
                <p className="text-lg font-medium leading-7">
                  You&apos;ve successfully connected with {config.label}!
                </p>
                <p className="text-sm leading-5">
                  You can now let some of your agents to use this connector
                </p>
              </div>

              {/* Search */}
              <div className="relative w-full">
                <IconSearch
                  size={15}
                  stroke={1.5}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                />
                <input
                  type="text"
                  placeholder="Search your agents"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                  className="h-9 w-full rounded-lg border border-[#c6cdd7] bg-white pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
                />
              </div>
            </div>

            {/* Agent grid */}
            <div className="grid grid-cols-4 gap-x-2 gap-y-2.5">
              {visibleAgents.map((agent) => {
                const isSelected = selected.has(agent.id);
                const avatarSrc =
                  resolveAvatarUrl(agent.avatarUrl) ?? ZERO_AVATARS[0];
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      toggle(agent.id);
                    }}
                    className="flex items-center gap-2 rounded-xl border-[0.7px] border-[#c6cdd7] bg-white p-2.5 shadow-[0px_1px_3px_0px_rgba(45,49,57,0.08)] transition-colors hover:bg-muted"
                  >
                    {isSelected ? (
                      <IconCircleCheckFilled
                        size={27}
                        className="shrink-0 text-[#ed4e01]"
                      />
                    ) : (
                      <img
                        src={avatarSrc}
                        alt={agent.displayName ?? "Agent"}
                        className="h-[27px] w-[27px] shrink-0 rounded-full object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-left text-xs">
                      {agent.displayName ?? "Unnamed"}
                    </span>
                  </button>
                );
              })}
              {remainingCount > 0 && (
                <div className="flex items-center gap-2 rounded-xl border-[0.7px] border-[#c6cdd7] bg-white p-2.5 shadow-[0px_1px_3px_0px_rgba(45,49,57,0.08)]">
                  <img
                    src={ZERO_AVATARS[0]}
                    alt="More"
                    className="h-[27px] w-[27px] shrink-0 rounded-full object-cover"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {remainingCount}+ more
                  </span>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="flex-row items-center justify-center gap-2 sm:justify-center sm:gap-2">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={submitting}
              className="h-9 w-[130px] rounded-[10px]"
            >
              Later
            </Button>
            <Button
              onClick={() => {
                detach(
                  confirm(connectorType, onClose, pageSignal),
                  Reason.DomCallback,
                );
              }}
              disabled={submitting}
              className="h-9 w-[130px] rounded-[10px] bg-[#ed4e01] text-white hover:bg-[#d94500]"
            >
              {submitting ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
