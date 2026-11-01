import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import ExcalidrawApp from "./App";

// the entry's JavaScript and CSS loaded and ran (`scripts/stats/perf.mjs`)
performance.mark("excalidraw:app-start");

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
// the desktop app serves the files itself, a service worker would only keep
// serving stale versions after updates
if (import.meta.env.VITE_APP_DESKTOP !== "true") {
  registerSW();
}
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
