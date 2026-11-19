import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { translate } from "../shared/i18n";
import { LanguageContext } from "./i18n";
import LegalPage from "./LegalPage";
import "./styles.css";

const App = React.lazy(() => import("./App"));
const path = window.location.pathname.replace(/\/+$/, "");
const legalPage = path === "/privacy" ? "privacy" : path === "/terms" ? "terms" : undefined;
const language = new URLSearchParams(window.location.search).get("lang") === "en" ? "en" : "de";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<React.StrictMode>
  {legalPage ? <LanguageContext.Provider value={language}><LegalPage page={legalPage} /></LanguageContext.Provider>
    : <React.Suspense fallback={<main className="loading"><h1>Splitty</h1><p>{translate("de", "Opening your shared ledger…")}</p></main>}><App /></React.Suspense>}
</React.StrictMode>);

if (!legalPage) {
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
}
