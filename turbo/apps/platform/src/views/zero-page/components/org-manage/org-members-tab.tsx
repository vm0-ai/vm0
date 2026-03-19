import { useGet, useLoadable, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import { IconSearch, IconShieldCheck } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import {
  orgMembers$,
  type OrgMember,
} from "../../../../signals/external/org-members.ts";
import { user$ } from "../../../../signals/auth.ts";

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function OrgMembersTab() {
  const membersLoadable = useLoadable(orgMembers$);
  const userLoadable = useLoadable(user$);
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isLoading = membersLoadable.state === "loading";

  const filtered = (() => {
    if (!search.trim()) {
      return members;
    }
    const q = search.toLowerCase();
    return members.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        displayName(m).toLowerCase().includes(q),
    );
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="relative w-80">
        <IconSearch
          size={15}
          stroke={1.5}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <input
          type="text"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10"
        />
      </div>

      <div
        className="overflow-hidden rounded-[10px] bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-4 py-3 text-sm font-medium text-foreground bg-card",
          )}
        >
          <div className="text-left">User</div>
          <div className="text-left">Joined</div>
          <div className="text-left">Role</div>
          <div />
        </div>
        <div className="h-px bg-border/40 mx-4" />

        {isLoading && (
          <>
            <MemberRowSkeleton />
            <MemberRowSkeleton />
            <MemberRowSkeleton />
          </>
        )}

        {!isLoading && filtered.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-muted-foreground">
              {search.trim() ? "No members found" : "No members"}
            </span>
          </div>
        )}

        {!isLoading &&
          filtered.map((m, i) => (
            <div key={m.userId}>
              {i > 0 && <div className="h-px bg-border/40 mx-4" />}
              <MemberRow
                member={m}
                isCurrentUser={m.userId === currentUserId}
              />
            </div>
          ))}
      </div>
    </div>
  );
}

function MemberRow({
  member,
  isCurrentUser,
}: {
  member: OrgMember;
  isCurrentUser: boolean;
}) {
  const name = displayName(member);
  const initial = (name || member.email).charAt(0).toUpperCase();

  return (
    <div className={cn(ROW_GRID, "py-3 px-4")}>
      <div className="flex items-center gap-3 min-w-0">
        <MemberAvatar
          imageUrl={member.imageUrl}
          initial={initial}
          name={name || member.email}
        />
        <div className="min-w-0">
          {name && (
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground truncate">
              {name}
              {isCurrentUser && (
                <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground leading-none">
                  You
                </span>
              )}
            </span>
          )}
          <p className="text-[13px] text-muted-foreground truncate">
            {member.email}
          </p>
        </div>
      </div>
      <div className="text-left text-sm text-muted-foreground tabular-nums">
        {formatDate(member.joinedAt)}
      </div>
      <div className="text-left">
        <span
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground"
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            backgroundColor: "hsl(var(--gray-0))",
          }}
        >
          {member.role === "admin" && (
            <IconShieldCheck size={12} stroke={1.8} className="text-blue-500" />
          )}
          {member.role === "admin" ? "Admin" : "Member"}
        </span>
      </div>
      <div />
    </div>
  );
}

function MemberAvatar({
  imageUrl,
  initial,
  name,
}: {
  imageUrl: string;
  initial: string;
  name: string;
}) {
  if (imageUrl) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden">
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function MemberRowSkeleton() {
  return (
    <div className={cn(ROW_GRID, "py-3 px-4 animate-pulse")}>
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/50" />
        <div className="flex flex-col gap-1">
          <div className="h-4 w-24 rounded bg-muted/50" />
          <div className="h-3 w-36 rounded bg-muted/30" />
        </div>
      </div>
      <div className="h-4 w-20 rounded bg-muted/30" />
      <div className="h-5 w-14 rounded bg-muted/30" />
      <div />
    </div>
  );
}
