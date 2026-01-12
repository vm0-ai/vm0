import { useSet } from "ccstate-react";
import {
  Bot,
  Key,
  Package,
  ScrollText,
  KeyRound,
  Receipt,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import type { NavItem } from "../../types/navigation.ts";
import { navigateInReact$ } from "../../signals/route.ts";

const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  Key,
  Package,
  ScrollText,
  KeyRound,
  Receipt,
  BookOpen,
};

interface NavLinkProps {
  item: NavItem;
  isActive: boolean;
}

export function NavLink({ item, isActive }: NavLinkProps) {
  const navigate = useSet(navigateInReact$);
  const IconComponent = ICON_MAP[item.icon];

  return (
    <button
      onClick={() => {
        navigate(item.path);
      }}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        isActive
          ? "bg-sidebar-active text-sidebar-primary font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      {IconComponent && <IconComponent className="h-4 w-4" />}
      <span>{item.label}</span>
    </button>
  );
}
