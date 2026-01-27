import type { RoutePath } from "./route.ts";

type NavIconName =
  | "Bot"
  | "CircleDot"
  | "FileBarChart"
  | "List"
  | "KeyRound"
  | "Receipt"
  | "HelpCircle"
  | "Rocket"
  | "Lock"
  | "File"
  | "Files"
  | "SquareKey"
  | "Sparkles"
  | "Settings";

export interface NavItem {
  id: string;
  label: string;
  icon: NavIconName;
  path?: RoutePath;
  url?: string;
  newTab?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}
