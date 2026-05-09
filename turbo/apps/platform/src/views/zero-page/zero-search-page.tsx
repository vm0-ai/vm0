import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconArrowLeft, IconSearch, IconX } from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads$ } from "../../signals/chat-page/chat-message.ts";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";

function formatThreadDateLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const startOf = (date: Date) => {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ).getTime();
  };
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (dayDiff === 0) {
    return "Today";
  }
  if (dayDiff === 1) {
    return "Yesterday";
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function ResultRow({ session }: { session: ChatThreadListItem }) {
  const dateLabel = formatThreadDateLabel(
    session.updatedAt ?? session.createdAt,
    new Date(),
  );
  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: session.id } }}
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent/50 transition-colors no-underline text-foreground"
    >
      <AvatarFromUrl
        avatarUrl={session.agent.avatarUrl}
        alt=""
        className="h-10 w-10 shrink-0 rounded-full object-cover object-top"
      />
      <span className="min-w-0 flex-1 truncate text-[16px] font-medium">
        {session.title ?? "New chat"}
      </span>
      {dateLabel && (
        <span className="shrink-0 text-[14px] text-muted-foreground tabular-nums">
          {dateLabel}
        </span>
      )}
    </Link>
  );
}

export function ZeroSearchPage() {
  const term = useGet(chatListQuery$);
  const setTerm = useSet(setChatListQuery$);
  const navigate = useSet(detachedNavigateTo$);

  const recentLoadable = useLastLoadable(chatThreads$);
  const recent = recentLoadable.state === "hasData" ? recentLoadable.data : [];
  const loading = recentLoadable.state === "loading";

  const trimmed = term.trim().toLowerCase();
  const results = trimmed
    ? recent.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmed);
      })
    : recent;

  const onClose = () => {
    setTerm("");
    navigate("/chats");
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div
        className="md:hidden shrink-0 relative flex items-center h-12 gap-1 px-2 bg-background border-b border-border/50 z-10"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          data-testid="mobile-search-back"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <IconArrowLeft size={18} stroke={1.8} />
        </button>
        <div className="flex flex-1 items-center gap-2 rounded-lg bg-muted/50 px-3 h-9">
          <IconSearch
            size={16}
            stroke={2}
            className="shrink-0 text-muted-foreground"
          />
          <input
            type="text"
            value={term}
            autoFocus
            onChange={(e) => {
              setTerm(e.target.value);
            }}
            placeholder="Search chats"
            data-testid="mobile-search-input"
            className="flex-1 min-w-0 bg-transparent text-[16px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {term && (
            <button
              type="button"
              onClick={() => {
                setTerm("");
              }}
              aria-label="Clear search"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <IconX size={14} stroke={2} />
            </button>
          )}
        </div>
      </div>
      <div
        className={cn(
          "flex-1 overflow-auto px-3 py-3",
          loading && "opacity-60",
        )}
      >
        {results.length === 0 ? (
          <p className="px-3 py-8 text-[16px] text-muted-foreground text-center">
            {trimmed
              ? "No chats match your search"
              : "Type to search your chats"}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((session) => {
              return <ResultRow key={session.id} session={session} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
