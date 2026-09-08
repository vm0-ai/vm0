import type { MenuItemConstructorOptions } from "electron";
import type { DeveloperToolsController } from "./desktop-developer-tools-controller";

export function desktopDeveloperToolsMenu(developer: DeveloperToolsController) {
  const state = developer.getState();
  if (!state.available) return [];
  return [
    {
      label: "Developer Tools",
      type: "checkbox",
      checked: state.enabled,
      click: () => {
        developer.setEnabled(!developer.getState().enabled);
      },
    },
    { type: "separator" },
  ] satisfies MenuItemConstructorOptions[];
}
