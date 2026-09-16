import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { WorkflowRuntimeProvider } from "./runtime.js";
import { applyStoredTheme } from "./theme.js";
import "./styles.css";

// Before first paint, so a light-theme operator never sees a dark flash.
applyStoredTheme();

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

createRoot(container).render(
  <WorkflowRuntimeProvider>
    <App />
  </WorkflowRuntimeProvider>,
);
