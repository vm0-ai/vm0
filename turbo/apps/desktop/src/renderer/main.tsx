import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@sentry/react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { App } from "./App";
import { initRendererSentry } from "./sentry";
import "./styles.css";

initRendererSentry();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Desktop renderer root element is missing");
}

const store = createStore();
const root = createRoot(rootElement);

root.render(
  <StrictMode>
    <StoreProvider value={store}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StoreProvider>
  </StrictMode>,
);
