import type { Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { StrictMode } from "react";
import { ErrorBoundary } from "./error-boundary.tsx";
import { Router } from "./router.tsx";
import "./css/index.css";

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <ErrorBoundary>
          <Router />
        </ErrorBoundary>
      </StoreProvider>
    </StrictMode>,
  );
};
