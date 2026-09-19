import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { applyStoredPalette } from "./theme/palettes.js";
import { applyStoredTheme } from "./theme.js";
import "./styles.css";

// Before first paint, so a light-theme operator never sees a dark flash and
// a focus-mode operator never sees both rails for a frame.
applyStoredTheme();
applyStoredPalette();
try {
  document.documentElement.dataset.rails = window.localStorage.getItem("workflow.rails") === "off" ? "off" : "on";
} catch {
  document.documentElement.dataset.rails = "on";
}

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

createRoot(container).render(<App />);
