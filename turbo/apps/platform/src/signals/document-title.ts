import { command } from "ccstate";
import { brandName$ } from "./branding.ts";

export const updateDocumentTitle$ = command(({ get }, pageName: string) => {
  const brandName = get(brandName$);
  const brandSuffix = ` | ${brandName}`;
  document.title =
    pageName === brandName || pageName.endsWith(brandSuffix)
      ? pageName
      : `${pageName}${brandSuffix}`;
});
