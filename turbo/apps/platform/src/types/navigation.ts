import type { RoutePath } from "./route.ts";

type NavIconName =
  | "Bot"
  | "CircleDot"
  | "FileBarChart"
  | "List"
  | "KeyRound"
  | "Receipt"
  | "HelpCircle"
  | "Rocket";

export interface NavItem {
  id: string;
  label: string;
  icon: NavIconName;
  path: RoutePath;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}
