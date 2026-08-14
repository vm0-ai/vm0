import { command } from "ccstate";
import { brandName$, type BrandName } from "./branding.ts";

export const updateDocumentTitle$ = command(
  ({ get }, pageName: string, brandNameOverride?: BrandName) => {
    const brandName = brandNameOverride ?? get(brandName$);
    const brandSuffix = ` | ${brandName}`;
    document.title =
      pageName === brandName || pageName.endsWith(brandSuffix)
        ? pageName
        : `${pageName}${brandSuffix}`;
  },
);
