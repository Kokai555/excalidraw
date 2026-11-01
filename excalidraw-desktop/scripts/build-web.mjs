// Builds the web app (excalidraw-app) for the desktop app into `web/`.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoDir = path.resolve(desktopDir, "..");
const appDir = path.join(repoDir, "excalidraw-app");
// installed by `yarn` in the repo root
const vite = path.join(repoDir, "node_modules", ".bin", "vite");

const result = spawnSync(
  vite,
  ["build", "--outDir", path.join(desktopDir, "web"), "--emptyOutDir"],
  {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_APP_DESKTOP: "true",
      VITE_APP_DISABLE_SENTRY: "true",
      VITE_APP_ENABLE_TRACKING: "false",
      VITE_APP_ENABLE_ESLINT: "false",
    },
  },
);

process.exit(result.status ?? 1);
