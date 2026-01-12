import { useSet } from "ccstate-react";
import {
  Bot,
  CircleDot,
  FileBarChart,
  List,
  KeyRound,
  Receipt,
  HelpCircle,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import type { NavItem } from "../../types/navigation.ts";
import { navigateInReact$ } from "../../signals/route.ts";

// eslint-disable-next-line ccstate/no-package-variable -- static readonly icon mapping
const ICON_MAP = {
  Bot,
  CircleDot,
  FileBarChart,
  List,
  KeyRound,
  Receipt,
  HelpCircle,
  Rocket,
} as const satisfies Record<string, LucideIcon>;

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
      className={`flex w-full items-center gap-2 h-8 p-2 rounded-lg text-sm leading-5 transition-colors ${
        isActive
          ? "bg-sidebar-active text-sidebar-primary font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      {IconComponent && <IconComponent className="size-4 shrink-0" />}
      <span className="truncate">{item.label}</span>
    </button>
  );
}
