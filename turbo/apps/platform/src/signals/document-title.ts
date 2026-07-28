import { command } from "ccstate";
import { brandName$ } from "./branding.ts";

export const updateDocumentTitle$ = command(({ get }, pageName: string) => {
  document.title = `${pageName} | ${get(brandName$)}`;
});
