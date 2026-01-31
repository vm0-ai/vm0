import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { IconDotsVertical, IconUser, IconLogout } from "@tabler/icons-react";
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
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { sidebarCollapsed$ } from "../../signals/sidebar.ts";
import { theme$ } from "../../signals/theme.ts";
import {
  userMenuOpen$,
  toggleUserMenu$,
  closeUserMenu$,
} from "../../signals/user-menu.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);
  const theme = useGet(theme$);
  const collapsed = useGet(sidebarCollapsed$);
  const featureSwitches = useLastResolved(featureSwitch$);
  if (!featureSwitches) {
    return null;
  }

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ${
        collapsed ? "w-16" : "w-[255px]"
      }`}
    >
      <div className="h-[49px] flex flex-col justify-center p-2 border-b border-divider">
        <div
          className={`flex items-center h-8 ${collapsed ? "justify-center" : "gap-2.5 p-1.5"}`}
        >
          <div className="inline-grid grid-cols-[max-content] grid-rows-[max-content] items-start justify-items-start leading-[0] shrink-0">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="col-1 row-1 block max-w-none"
              style={
                collapsed
                  ? { width: "32px", height: "32px" }
                  : { width: "81px", height: "24px" }
              }
            />
          </div>
          {!collapsed && (
            <p className="text-xl font-normal leading-7 text-foreground shrink-0">
              Platform
            </p>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-2 overflow-y-auto overflow-x-hidden">
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <NavLink
              item={GET_STARTED_ITEM}
              isActive={activeItem === GET_STARTED_ITEM.id}
            />
          </div>
        </div>

        {NAVIGATION_CONFIG.map((group) => {
          if (
            group.label === "Content" &&
            !featureSwitches?.platformArtifacts
          ) {
            return null;
          }

          if (
            group.label === "Your agents" &&
            !featureSwitches?.platformAgents &&
            !featureSwitches?.platformSecrets
          ) {
            return null;
          }

          if (
            group.label === "Developers" &&
            !featureSwitches?.platformApiKeys
          ) {
            return null;
          }

          if (group.label === "Observation" && !featureSwitches?.platformLogs) {
            return null;
          }

          return (
            <div key={group.label} className="p-2">
              {!collapsed && (
                <div className="h-8 flex items-center px-2 opacity-70">
                  <span className="text-xs leading-4 text-sidebar-foreground">
                    {group.label}
                  </span>
                </div>
              )}
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
          );
        })}
      </div>

      <div className="p-2">
        <div className="flex flex-col gap-1">
          {featureSwitches?.pricing && <VM0SubscriptionDetailsButton />}
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
  const collapsed = useGet(sidebarCollapsed$);
  const isMenuOpen = useGet(userMenuOpen$);
  const toggleMenu = useSet(toggleUserMenu$);
  const closeMenu = useSet(closeUserMenu$);

  if (userLoadable.state !== "hasData" || !userLoadable.data) {
    return null;
  }

  const user = userLoadable.data;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const handleManageAccount = () => {
    closeMenu();
    detach(clerk?.openUserProfile(), Reason.DomCallback);
  };

  const handleSignOut = () => {
    closeMenu();
    detach(clerk?.signOut(), Reason.DomCallback);
  };

  const avatarButton = (
    <button
      onClick={toggleMenu}
      className={`flex w-full items-center rounded-lg hover:bg-sidebar-accent transition-colors ${
        collapsed ? "justify-center p-2 h-12" : "gap-2 p-2 h-12"
      }`}
    >
      <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden shrink-0">
        <img
          src={user.imageUrl}
          alt={user.fullName ?? ""}
          className="h-full w-full object-cover"
        />
      </div>
      {!collapsed && (
        <>
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
            stroke={1.5}
            className="text-sidebar-foreground shrink-0"
          />
        </>
      )}
    </button>
  );

  return (
    <>
      {/* Backdrop overlay to close menu when clicking outside */}
      {isMenuOpen && <div className="fixed inset-0 z-10" onClick={closeMenu} />}

      <div className="p-2 relative z-20">
        {collapsed ? (
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>{avatarButton}</TooltipTrigger>
              <TooltipContent side="right">
                <p className="text-xs">{user.fullName}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          avatarButton
        )}

        {/* Popup Menu */}
        {isMenuOpen && (
          <div
            className={`absolute bottom-full mb-2 bg-card rounded-xl overflow-hidden ${
              collapsed ? "left-0 w-56" : "left-2 right-2"
            }`}
            style={{
              boxShadow:
                "0px 0px 4px rgba(0, 0, 0, 0.12), 0px 4px 12px rgba(25, 28, 33, 0.12), 0px 0px 0px 1px rgba(25, 28, 33, 0.04)",
            }}
          >
            {/* User Info Section */}
            <div className="px-5 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full border border-border overflow-hidden shrink-0">
                  <img
                    src={user.imageUrl}
                    alt={user.fullName ?? ""}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm leading-5 font-medium text-foreground truncate">
                    {user.fullName}
                  </div>
                  <div className="text-xs leading-4 text-muted-foreground truncate">
                    {user.primaryEmailAddress?.emailAddress}
                  </div>
                </div>
              </div>
            </div>

            {/* Manage Account */}
            <button
              onClick={handleManageAccount}
              className="w-full flex items-center gap-3 px-5 py-4 border-b border-border hover:bg-muted transition-colors text-left"
            >
              <div className="w-9 h-[18px] flex items-center justify-center shrink-0">
                <IconUser size={20} stroke={1.5} className="text-foreground" />
              </div>
              <span className="text-sm leading-5 text-foreground">
                Manage account
              </span>
            </button>

            {/* Sign Out */}
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-3 px-5 py-4 hover:bg-muted transition-colors text-left"
            >
              <div className="w-9 h-[18px] flex items-center justify-center shrink-0">
                <IconLogout
                  size={20}
                  stroke={1.5}
                  className="text-foreground"
                />
              </div>
              <span className="text-sm leading-5 text-foreground">
                Sign out
              </span>
            </button>
          </div>
        )}
      </div>
    </>
  );
}
