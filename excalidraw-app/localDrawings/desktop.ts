/**
 * Hooks for the desktop app (`excalidraw-desktop/`). Its main process has no
 * preload script; it calls these through `webContents.executeJavaScript`:
 *
 *   await window.__EXCALIDRAW_DESKTOP__.ready()  // resolves once the scene is loaded
 *   bridge.flush()                               // before the window closes
 *   bridge.openFile({ name, content, drawingPath })
 */

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { LocalData } from "../data/LocalData";

import {
  flushDrawingAutosave,
  openExternalFile,
  runLocalAction,
  showLocalToast,
} from "./localDrawings";

import type { DrawingPath } from "./constants";

export const isDesktopApp = import.meta.env.VITE_APP_DESKTOP === "true";

export type DesktopBridge = {
  /** writes pending changes to disk; resolves to false if that failed */
  flush: () => Promise<boolean>;
  /** opens a file the user opened with the app (e.g. from Finder) */
  openFile: (file: {
    name: string;
    content: string;
    /** set if the file is a drawing inside the drawings folder */
    drawingPath: DrawingPath | null;
  }) => Promise<void>;
};

declare global {
  interface Window {
    __EXCALIDRAW_DESKTOP__?: { ready: () => Promise<DesktopBridge> };
  }
}

let excalidrawAPI: ExcalidrawImperativeAPI | null = null;
let resolveReady: (bridge: DesktopBridge) => void = () => {};
const ready = new Promise<DesktopBridge>((resolve) => {
  resolveReady = resolve;
});

const bridge: DesktopBridge = {
  flush: async () => {
    LocalData.flushSave();
    return flushDrawingAutosave();
  },
  openFile: async (file) => {
    const api = excalidrawAPI;
    if (!api) {
      return;
    }
    const paths = await runLocalAction(() => openExternalFile(api, file));
    if (paths?.length && !file.drawingPath) {
      showLocalToast(`Imported "${file.name}" as a new drawing`, 3000);
    }
  },
};

if (isDesktopApp) {
  window.__EXCALIDRAW_DESKTOP__ = { ready: () => ready };
}

/** call once the initial scene is loaded */
export const setDesktopBridgeAPI = (api: ExcalidrawImperativeAPI) => {
  excalidrawAPI = api;
  if (isDesktopApp) {
    resolveReady(bridge);
  }
};
