import type { ReactNode } from "react";

export function WorkspaceInset({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="okou-workspace-bg flex min-h-0 min-w-0 flex-1 flex-col bg-background md:m-2 md:ml-0 md:overflow-hidden md:rounded-xl md:border-[0.7px] md:border-border"
      data-testid="workspace-inset"
    >
      {children}
    </div>
  );
}
