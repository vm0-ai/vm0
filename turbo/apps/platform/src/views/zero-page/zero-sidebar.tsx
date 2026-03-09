import { useState, type ComponentType } from "react";
import {
  IconMessageCircle,
  IconRobot,
  IconFile,
  IconChartLine,
  IconSelector,
  IconLayoutGrid,
  IconCalendar,
  IconAdjustmentsHorizontal,
  IconUser,
  IconUsers,
  IconLogout,
} from "@tabler/icons-react";
import { useLoadable } from "ccstate-react";
import slackIcon from "../settings-page/icons/slack.svg";
import { clerk$, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";

export type ZeroNavId =
  | "chat"
  | "meet"
  | "schedule"
  | "job"
  | "production"
  | "activity"
  | "works"
  | "account";

const MAIN_NAV: {
  id: ZeroNavId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}[] = [
  { id: "chat", label: "Chat with Zero", icon: IconMessageCircle },
  { id: "meet", label: "Meet Zero", icon: IconRobot },
  { id: "job", label: "Zero's team", icon: IconUsers },
  { id: "schedule", label: "Schedule", icon: IconCalendar },
  { id: "production", label: "Documents", icon: IconFile },
  { id: "activity", label: "Activities", icon: IconChartLine },
];

const RECENT_ITEMS: { id: string; label: string }[] = [
  { id: "hello", label: "Hello from Zero" },
  { id: "1", label: "Daily digest workflow" },
  { id: "2", label: "Set up Slack integration" },
  { id: "3", label: "Weekly report automation" },
  { id: "4", label: "Code review reminders" },
];

const FOOTER_NAV: {
  id: ZeroNavId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconImg?: string;
}[] = [
  {
    id: "works",
    label: "Where Zero works",
    icon: IconLayoutGrid,
    iconImg: slackIcon,
  },
];

export type ZeroAccountAction = "preferences" | "manage" | "signout";

export type ZeroAccountSubId = "preferences" | null;

interface ZeroSidebarProps {
  activeId: ZeroNavId;
  onSelect: (id: ZeroNavId) => void;
  onRecentSelect?: (id: string) => void;
  selectedRecentId?: string | null;
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
  onAccountAction?: (action: ZeroAccountAction) => void;
}

function AccountMenuPopup({
  accountName,
  accountEmail,
  accountInitial,
  imageUrl,
  onAction,
}: {
  accountName: string;
  accountEmail: string;
  accountInitial: string;
  imageUrl: string | undefined;
  onAction: (action: ZeroAccountAction) => void;
}) {
  return (
    <div className="zero-card-rectangle absolute bottom-full left-0 right-0 mb-2 overflow-hidden z-20">
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          {imageUrl ? (
            <div className="h-9 w-9 shrink-0 rounded-xl overflow-hidden">
              <img
                src={imageUrl}
                alt={accountName}
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="h-9 w-9 rounded-xl bg-orange-200/95 dark:bg-orange-300/80 flex items-center justify-center text-orange-900 dark:text-orange-950 text-sm font-medium shrink-0">
              {accountInitial}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm leading-5 font-medium text-foreground truncate">
              {accountName}
            </div>
            <div className="text-xs leading-4 text-muted-foreground truncate">
              {accountEmail}
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onAction("preferences")}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-border hover:bg-muted transition-colors text-left"
      >
        <div className="w-9 h-[18px] flex items-center justify-center shrink-0">
          <IconAdjustmentsHorizontal
            size={20}
            stroke={1.5}
            className="text-foreground"
          />
        </div>
        <span className="text-sm leading-5 text-foreground">Preferences</span>
      </button>
      <button
        type="button"
        onClick={() => onAction("manage")}
        className="w-full flex items-center gap-3 px-5 py-4 border-b border-border hover:bg-muted transition-colors text-left"
      >
        <div className="w-9 h-[18px] flex items-center justify-center shrink-0">
          <IconUser size={20} stroke={1.5} className="text-foreground" />
        </div>
        <span className="text-sm leading-5 text-foreground">
          Manage account
        </span>
      </button>
      <button
        type="button"
        onClick={() => onAction("signout")}
        className="w-full flex items-center gap-3 px-5 py-4 hover:bg-muted transition-colors text-left"
      >
        <div className="w-9 h-[18px] flex items-center justify-center shrink-0">
          <IconLogout size={20} stroke={1.5} className="text-foreground" />
        </div>
        <span className="text-sm leading-5 text-foreground">Sign out</span>
      </button>
    </div>
  );
}

function AccountDropdown({
  activeId,
  onAccountAction,
}: {
  activeId: ZeroNavId;
  onAccountAction?: (action: ZeroAccountAction) => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const clerkLoadable = useLoadable(clerk$);
  const userLoadable = useLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const accountName = user?.fullName ?? "User";
  const accountEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const accountInitial = accountName.charAt(0).toUpperCase();

  const closeAccountMenu = () => setAccountMenuOpen(false);

  const handleAccountAction = (action: ZeroAccountAction) => {
    closeAccountMenu();
    if (action === "signout") {
      detach(clerk?.signOut(), Reason.DomCallback);
      return;
    }
    if (action === "manage") {
      detach(clerk?.openUserProfile(), Reason.DomCallback);
      return;
    }
    onAccountAction?.(action);
  };

  return (
    <div className="mt-2 pt-1 relative">
      {accountMenuOpen && (
        <div
          className="fixed inset-0 z-10"
          onClick={closeAccountMenu}
          aria-hidden="true"
        />
      )}
      <div
        className={`rounded-lg p-2 transition-colors duration-200 ${
          activeId === "account" || accountMenuOpen
            ? "bg-sidebar-active"
            : "hover:bg-sidebar-accent/50"
        }`}
      >
        <button
          type="button"
          onClick={() => setAccountMenuOpen((open) => !open)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={accountMenuOpen}
          aria-haspopup="true"
        >
          {user?.imageUrl ? (
            <div className="h-8 w-8 shrink-0 rounded-xl overflow-hidden">
              <img
                src={user.imageUrl}
                alt={accountName}
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="h-8 w-8 shrink-0 rounded-xl bg-orange-200/95 dark:bg-orange-300/80 flex items-center justify-center text-orange-900 dark:text-orange-950 text-sm font-medium">
              {accountInitial}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p
              className={`text-sm font-medium leading-tight truncate ${
                activeId === "account" || accountMenuOpen
                  ? "text-sidebar-primary"
                  : "text-sidebar-foreground"
              }`}
            >
              {accountName}
            </p>
            <p
              className={`text-xs leading-tight truncate mt-px ${
                activeId === "account" || accountMenuOpen
                  ? "text-sidebar-primary/80"
                  : "text-sidebar-foreground opacity-70"
              }`}
            >
              {accountEmail}
            </p>
          </div>
        </button>
      </div>

      {accountMenuOpen && (
        <AccountMenuPopup
          accountName={accountName}
          accountEmail={accountEmail}
          accountInitial={accountInitial}
          imageUrl={user?.imageUrl}
          onAction={handleAccountAction}
        />
      )}
    </div>
  );
}

export function ZeroSidebar({
  activeId,
  onSelect,
  onRecentSelect,
  selectedRecentId = null,
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
  onAccountAction,
}: ZeroSidebarProps) {
  return (
    <aside className="zero-nav flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
      {/* Zero + workspace — single module */}
      <div className="shrink-0 p-2 pb-1">
        <div className="rounded-lg p-2 transition-colors duration-200 hover:bg-sidebar-accent/50">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onAvatarClick}
              className="h-8 w-8 shrink-0 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch Zero avatar"
            >
              <img
                src={zeroAvatarSrc}
                alt="Zero"
                className="h-8 w-8 rounded-full object-cover object-top"
                width={32}
                height={32}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-tight text-sidebar-foreground truncate">
                Personal Workspace
              </p>
              <p className="text-xs leading-tight text-sidebar-foreground opacity-70 truncate mt-px">
                Free • Owner
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-sidebar-foreground hover:bg-sidebar-accent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch workspace"
            >
              <IconSelector size={14} stroke={1.5} />
            </button>
          </div>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
        <div className="flex flex-col gap-1">
          {MAIN_NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                activeId === id
                  ? "bg-sidebar-active text-sidebar-primary font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>

        {/* Recent dialogue — no extra wrapper padding so label/items align with main nav (nav already has p-2) */}
        <div className="mt-4">
          <div className="zero-nav-recent-label h-8 flex items-center px-2">
            <span className="text-xs leading-4 text-sidebar-foreground uppercase tracking-wider">
              recent chat
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {RECENT_ITEMS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => onRecentSelect?.(id)}
                className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
                  selectedRecentId === id
                    ? "bg-sidebar-active text-sidebar-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <span className="truncate min-w-0 flex-1">{label}</span>
                {id === "hello" && (
                  <span
                    className="shrink-0 w-1.5 h-1.5 rounded-full bg-red-500"
                    aria-hidden
                  />
                )}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Footer nav */}
      <div className="p-2">
        <div className="flex flex-col gap-1">
          {FOOTER_NAV.map(({ id, label, icon: Icon, iconImg }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`flex w-full h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors duration-200 ${
                activeId === id
                  ? "bg-sidebar-active text-sidebar-primary font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              }`}
            >
              {iconImg ? (
                <img
                  src={iconImg}
                  alt=""
                  className="h-4 w-4 shrink-0"
                  width={16}
                  height={16}
                />
              ) : (
                <Icon size={16} className="shrink-0" />
              )}
              <span className="truncate">{label}</span>
            </button>
          ))}
          {/* Account — dropdown (aligned with workspace block above) */}
          <AccountDropdown
            activeId={activeId}
            onAccountAction={onAccountAction}
          />
        </div>
      </div>
    </aside>
  );
}
