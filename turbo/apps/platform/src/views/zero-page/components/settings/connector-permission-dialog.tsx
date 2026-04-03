import { useState } from "react";
import { useLastResolved, useGet } from "ccstate-react";
import { IconSearch } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import {
  CONNECTOR_TYPES,
  zeroUserConnectorsContract,
  type ConnectorType,
} from "@vm0/core";
import { agents$ } from "../../../../signals/zero-page/agents-list.ts";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { resolveAvatarUrl } from "../../avatar-utils.ts";
import { ZERO_AVATARS } from "../../zero-avatars.ts";
import { ConnectorIcon } from "./connector-icons.tsx";

const VISIBLE_AGENT_COUNT = 15;

interface ConnectorPermissionDialogProps {
  connectorType: ConnectorType;
  onClose: () => void;
}

export function ConnectorPermissionDialog({
  connectorType,
  onClose,
}: ConnectorPermissionDialogProps) {
  const allAgents = useLastResolved(agents$);
  const createClient = useGet(zeroClient$);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    const client = createClient(zeroUserConnectorsContract);
    detach(
      Promise.allSettled(
        [...selected].map(async (agentId) => {
          const existing = await client.get({ params: { id: agentId } });
          const current =
            existing.status === 200 ? existing.body.enabledTypes : [];
          if (current.includes(connectorType)) {
            return;
          }
          await client.update({
            params: { id: agentId },
            body: { enabledTypes: [...current, connectorType] },
          });
        }),
      ).then(() => {
        setSubmitting(false);
        onClose();
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader className="items-center text-center">
          <div className="flex h-10 w-10 items-center justify-center">
            <ConnectorIcon type={connectorType} size={32} />
          </div>
          <DialogTitle>{config.label}</DialogTitle>
          <DialogDescription>
            You&apos;ve successfully connected with {config.label}!
            <br />
            You can now let some of your agents to use this connector
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
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
            className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
          />
        </div>

        {/* Agent grid */}
        <div className="flex flex-wrap gap-2">
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
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card text-foreground hover:bg-muted"
                }`}
              >
                <img
                  src={avatarSrc}
                  alt={agent.displayName ?? "Agent"}
                  className="h-5 w-5 shrink-0 rounded-full object-cover"
                />
                <span className="max-w-[80px] truncate">
                  {agent.displayName ?? "Unnamed"}
                </span>
              </button>
            );
          })}
          {remainingCount > 0 && (
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
              {remainingCount}+ more
            </span>
          )}
        </div>

        <DialogFooter className="flex-row justify-end gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Later
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={submitting}
            className="bg-orange-500 text-white hover:bg-orange-600"
          >
            {submitting ? "Saving..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
