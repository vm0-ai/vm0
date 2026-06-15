import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Desktop renderer root element is missing");
}

const store = createStore();
const root = createRoot(rootElement);

root.render(
  <StrictMode>
    <StoreProvider value={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
