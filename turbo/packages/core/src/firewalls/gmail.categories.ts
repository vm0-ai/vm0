import type { PermissionNamesOf } from "./index";
import { gmailFirewall } from "./gmail.generated";
import { registerCategories } from "./categories";

const gmailCategories: Record<
  PermissionNamesOf<typeof gmailFirewall>,
  string
> = {
  // Read (5)
  "gmail.readonly": "Read",
  "gmail.metadata": "Read",
  "gmail.addons.current.message.readonly": "Read",
  "gmail.addons.current.message.metadata": "Read",
  "gmail.addons.current.message.action": "Read",

  // Compose (6)
  gmail: "Compose",
  "gmail.modify": "Compose",
  "gmail.compose": "Compose",
  "gmail.send": "Compose",
  "gmail.insert": "Compose",
  "gmail.addons.current.action.compose": "Compose",

  // Admin (3)
  "gmail.settings.basic": "Admin",
  "gmail.settings.sharing": "Admin",
  "gmail.labels": "Admin",
};

const gmailCategoryOrder = ["Read", "Compose", "Admin"] as const;

registerCategories("gmail", {
  categories: gmailCategories,
  displayOrder: gmailCategoryOrder,
});
