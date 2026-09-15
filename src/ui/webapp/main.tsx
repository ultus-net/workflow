import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { WorkflowRuntimeProvider } from "./runtime.js";
import "./styles.css";

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
