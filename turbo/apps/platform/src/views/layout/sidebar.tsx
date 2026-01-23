import { useGet, useLoadable } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  NAVIGATION_CONFIG,
  FOOTER_NAV_ITEMS,
  GET_STARTED_ITEM,
  activeNavItem$,
} from "../../signals/layout/navigation.ts";
import { clerk$, user$ } from "../../signals/auth.ts";
import { NavLink } from "./nav-link.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { VM0SubscriptionDetailsButton } from "../clerk/subscription-detail.tsx";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);

  return (
    <aside className="hidden md:flex w-[255px] flex-col border-r border-sidebar-border bg-sidebar">
      <div className="h-[49px] flex flex-col justify-center p-2 border-b border-divider">
        <div className="flex items-center gap-2.5 p-1.5 h-8">
          <div className="inline-grid grid-cols-[max-content] grid-rows-[max-content] items-start justify-items-start leading-[0] shrink-0">
            <img
              src="/logo_light.svg"
              alt="VM0"
              className="col-1 row-1 block max-w-none"
              style={{ width: "81px", height: "24px" }}
            />
          </div>
          <p className="text-xl font-normal leading-7 text-foreground shrink-0">
            Platform
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <NavLink
              item={GET_STARTED_ITEM}
              isActive={activeItem === GET_STARTED_ITEM.id}
            />
          </div>
          <div className="h-8 flex items-center px-2 opacity-70">
            <span className="text-xs leading-4 text-sidebar-foreground">
              Your agents
            </span>
          </div>
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

        {NAVIGATION_CONFIG.slice(1).map((group) => (
          <div key={group.label} className="p-2">
            <div className="h-8 flex items-center px-2 opacity-70">
              <span className="text-xs leading-4 text-sidebar-foreground">
                {group.label}
              </span>
            </div>
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

      <div className="p-2">
        <div className="flex flex-col gap-1">
          <VM0SubscriptionDetailsButton />
          {FOOTER_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
            />
          ))}
        </div>
      </div>

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
        <IconDotsVertical
          size={16}
          className="text-sidebar-foreground shrink-0"
        />
      </button>
    </div>
  );
}
