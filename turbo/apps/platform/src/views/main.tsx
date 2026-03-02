import { StrictMode } from "react";
import { Toaster } from "@vm0/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { Router } from "./router.tsx";
import "./css/index.css";

export const setupRouter = (
  StoreWrapper: React.ComponentType<{ children: React.ReactNode }>,
  render: (children: React.ReactNode) => void,
) => {
  render(
    <StrictMode>
      <StoreWrapper>
        <ErrorBoundary>
          <Router />
        </ErrorBoundary>
        <Toaster position="top-center" />
      </StoreWrapper>
    </StrictMode>,
  );
};
