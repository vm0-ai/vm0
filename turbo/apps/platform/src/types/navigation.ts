import type { RoutePath } from "./route.ts";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  path: RoutePath;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}
