import { useGet, useLoadable } from "ccstate-react";
import { MoreVertical, Receipt } from "lucide-react";
import { SubscriptionDetailsButton } from "@clerk/clerk-react/experimental";
import {
  NAVIGATION_CONFIG,
  FOOTER_NAV_ITEMS,
  GET_STARTED_ITEM,
  activeNavItem$,
} from "../../signals/layout/navigation.ts";
import { clerk$, user$ } from "../../signals/auth.ts";
import { NavLink } from "./nav-link.tsx";
import { ClerkProvider } from "./clerk-provider.tsx";
import { detach, Reason } from "../../signals/utils.ts";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);

  return (
    <aside className="hidden md:flex w-[255px] flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo header - height: 49px, padding: 8px */}
      <div className="h-[49px] flex flex-col justify-center p-2 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5 p-1.5 h-8">
          <img src="/logo_light.svg" alt="VM0" width={82} height={20} />
          <span className="text-2xl font-medium leading-8 text-sidebar-foreground">
            Platform
          </span>
        </div>
      </div>

      {/* Main navigation area - gap: 8px between sections */}
      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {/* Get started section */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <NavLink
              item={GET_STARTED_ITEM}
              isActive={activeItem === GET_STARTED_ITEM.id}
            />
          </div>
          {/* Your agents section label - height: 32px, px: 8px, opacity: 70% */}
          <div className="h-8 flex items-center px-2 opacity-70">
            <span className="text-xs leading-4 text-sidebar-foreground">
              Your agents
            </span>
          </div>
          {/* Your agents items - gap: 4px */}
          <div className="flex flex-col gap-1">
            {NAVIGATION_CONFIG[0].items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                isActive={activeItem === item.id}
              />
            ))}
          </div>
        </div>

        {/* Other navigation groups */}
        {NAVIGATION_CONFIG.slice(1).map((group) => (
          <div key={group.label} className="p-2">
            {/* Section label - height: 32px, px: 8px, opacity: 70% */}
            <div className="h-8 flex items-center px-2 opacity-70">
              <span className="text-xs leading-4 text-sidebar-foreground">
                {group.label}
              </span>
            </div>
            {/* Menu items - gap: 4px */}
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  item={item}
                  isActive={activeItem === item.id}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer navigation - padding: 8px, gap: 4px */}
      <div className="p-2">
        <div className="flex flex-col gap-1">
          {/* Bill button - opens subscription management modal */}
          <ClerkProvider>
            <SubscriptionDetailsButton>
              <button className="flex w-full items-center gap-2 p-2 h-9 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
                <Receipt className="h-4 w-4 shrink-0" />
                <span className="text-sm leading-5">Bill</span>
              </button>
            </SubscriptionDetailsButton>
          </ClerkProvider>
          {FOOTER_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
            />
          ))}
        </div>
      </div>

      {/* User profile section - padding: 8px */}
      <UserProfile />
    </aside>
  );
}

function UserProfile() {
  const clerkLoadable = useLoadable(clerk$);
  const userLoadable = useLoadable(user$);

  if (userLoadable.state !== "hasData" || !userLoadable.data) {
    return null;
  }

  const user = userLoadable.data;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const handleClick = () => {
    detach(clerk?.openUserProfile(), Reason.DomCallback);
  };

  return (
    <div className="p-2">
      <button
        onClick={handleClick}
        className="flex w-full items-center gap-2 p-2 h-12 rounded-lg hover:bg-sidebar-accent transition-colors"
      >
        <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden shrink-0">
          <img
            src={user.imageUrl}
            alt={user.fullName ?? ""}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm leading-5 text-sidebar-foreground truncate">
            {user.fullName}
          </div>
          <div className="text-xs leading-4 text-sidebar-foreground/70 truncate">
            {user.primaryEmailAddress?.emailAddress}
          </div>
        </div>
        <MoreVertical className="h-4 w-4 text-sidebar-foreground shrink-0" />
      </button>
    </div>
  );
}
