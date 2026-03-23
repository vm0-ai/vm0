import { command } from "ccstate";

export const updateDocumentTitle$ = command((_ctx, pageName: string) => {
  document.title = `${pageName} | VM0`;
});
