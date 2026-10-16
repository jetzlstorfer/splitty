import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);

const update = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("splitty-update", { detail: () => update(true) }));
  },
  onRegisterError(error: unknown) {
    window.dispatchEvent(new CustomEvent("splitty-error", {
      detail: `Offline setup failed: ${error instanceof Error ? error.message : String(error)}`
    }));
  }
});
