import * as React from "react";

export function asChildRender(children: React.ReactNode): React.ReactElement {
  if (!React.isValidElement(children)) {
    throw new Error("asChild requires exactly one React element");
  }
  return children;
}
