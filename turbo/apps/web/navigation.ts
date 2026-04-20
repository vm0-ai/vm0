import { createNavigation } from "next-intl/navigation";
import { locales } from "./i18n";

export const { Link, redirect, usePathname, useRouter } = createNavigation({
  locales,
});
