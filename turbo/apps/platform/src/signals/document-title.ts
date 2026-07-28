import { command } from "ccstate";
import { branding$ } from "./branding.ts";

export const updateDocumentTitle$ = command(({ get }, pageName: string) => {
  const brandName = get(branding$) === "okou" ? "Okou" : "VM0";
  document.title = `${pageName} | ${brandName}`;
});
