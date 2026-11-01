/**
 * Browser side of the local drawings feature: API client for the Vite plugin
 * (see `vitePlugin.ts`), autosave of the currently open drawing, and the
 * actions used by the drawings panel (open, create, rename, delete, …).
 */

import { MIME_TYPES } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  getNonDeletedElements,
} from "@excalidraw/element";
import {
  cleanAppStateForExport,
  getDefaultAppState,
} from "@excalidraw/excalidraw/appState";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { fileOpen } from "@excalidraw/excalidraw/data/filesystem";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";

import { LOCAL_DRAWINGS_API_PATH, MAX_DRAWING_NAME_LENGTH } from "./constants";

import type { DrawingsListResponse } from "./constants";

export const DEFAULT_DRAWING_NAME = "Névtelen rajz";

const CURRENT_DRAWING_STORAGE_KEY = "excalidraw-app-current-drawing";
const AUTOSAVE_DELAY = 800;
const AUTOSAVE_RETRY_DELAY = 5000;

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------

const readStoredCurrentDrawing = (): string | null => {
  try {
    return localStorage.getItem(CURRENT_DRAWING_STORAGE_KEY) || null;
  } catch {
    return null;
  }
};

/** name of the drawing the canvas is bound to (null = not saved to a file) */
export const currentDrawingNameAtom = atom<string | null>(
  readStoredCurrentDrawing(),
);

export type DrawingSaveState =
  | { status: "idle" | "saving" | "saved" }
  | { status: "error"; error: string };

export const drawingSaveStateAtom = atom<DrawingSaveState>({ status: "idle" });

/** bumped whenever the files on disk change, so the panel re-lists them */
export const drawingsRevisionAtom = atom(0);

/** null = not known yet, false = the API isn't reachable (e.g. static build) */
export const localDrawingsAvailableAtom = atom<boolean | null>(null);

export const getCurrentDrawing = () =>
  appJotaiStore.get(currentDrawingNameAtom);

const setCurrentDrawing = (name: string | null) => {
  appJotaiStore.set(currentDrawingNameAtom, name);
  appJotaiStore.set(drawingSaveStateAtom, { status: "idle" });
  try {
    if (name) {
      localStorage.setItem(CURRENT_DRAWING_STORAGE_KEY, name);
    } else {
      localStorage.removeItem(CURRENT_DRAWING_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable/full — the pointer then only lives in memory
  }
};

export const bumpDrawingsRevision = () => {
  appJotaiStore.set(drawingsRevisionAtom, (revision) => revision + 1);
};

/**
 * Other tabs share the same localStorage scene, so when we sync the scene from
 * another tab we must also adopt the drawing that tab has open. Otherwise we'd
 * autosave that tab's scene into our (different) file.
 */
export const syncCurrentDrawingFromStorage = () => {
  const stored = readStoredCurrentDrawing();
  if (stored !== getCurrentDrawing()) {
    appJotaiStore.set(currentDrawingNameAtom, stored);
    appJotaiStore.set(drawingSaveStateAtom, { status: "idle" });
  }
};

// -----------------------------------------------------------------------------
// API client
// -----------------------------------------------------------------------------

class LocalDrawingsError extends Error {
  constructor(message: string, public status: number | null) {
    super(message);
  }
}

export const isDrawingNotFoundError = (error: unknown) =>
  error instanceof LocalDrawingsError && error.status === 404;

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${LOCAL_DRAWINGS_API_PATH}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new LocalDrawingsError(
      "A helyi rajzszerver nem érhető el. Fut a `yarn start`?",
      null,
    );
  }
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // non-JSON response (e.g. index.html from a static server)
  }
  if (!response.ok || data === null) {
    throw new LocalDrawingsError(
      data?.error ||
        (data === null
          ? "A helyi rajzszerver nem érhető el."
          : `Szerverhiba (${response.status}).`),
      data === null ? null : response.status,
    );
  }
  return data as T;
};

const query = (name: string) => `?name=${encodeURIComponent(name)}`;

export const LocalDrawingsAPI = {
  list: () => request<DrawingsListResponse>("/"),
  read: async (name: string) =>
    (await request<{ content: string }>(`/drawing${query(name)}`)).content,
  write: (name: string, content: string) =>
    request<{ name: string }>(`/drawing${query(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  create: async (name: string, content: string) =>
    (
      await request<{ name: string }>("/drawing", {
        method: "POST",
        body: JSON.stringify({ name, content }),
      })
    ).name,
  rename: (from: string, to: string) =>
    request<{ name: string }>("/rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  remove: (name: string) =>
    request<{ name: string }>(`/drawing${query(name)}`, { method: "DELETE" }),
};

// -----------------------------------------------------------------------------
// autosave
// -----------------------------------------------------------------------------

const serializeScene = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => serializeAsJSON(getNonDeletedElements(elements), appState, files, "local");

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type PendingSave = {
  name: string;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

class DrawingAutosaver {
  /** last content written (or loaded) per drawing, to skip no-op writes */
  private lastSaved = new Map<string, string>();
  /** latest scene waiting for the debounce to elapse */
  private pending: PendingSave | null = null;
  /** content whose write failed, retried on the next flush */
  private failed: { name: string; content: string } | null = null;
  private timer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;

  schedule(save: PendingSave) {
    this.pending = save;
    if (this.failed?.name === save.name) {
      // superseded by newer content
      this.failed = null;
    }
    this.setTimer(AUTOSAVE_DELAY);
  }

  /** whether there's content that hasn't reached the disk yet */
  hasUnsavedChanges() {
    if (this.failed || this.inFlight > 0) {
      return true;
    }
    if (!this.pending) {
      return false;
    }
    // onChange also fires for UI-only changes (selection, scroll, …) which
    // don't change the file, so compare the actual content
    const { name, elements, appState, files } = this.pending;
    return (
      this.lastSaved.get(name) !== serializeScene(elements, appState, files)
    );
  }

  /** writes pending changes now; resolves to false if a write failed */
  async flush(): Promise<boolean> {
    this.clearTimer();
    const save = this.pending;
    this.pending = null;

    const write = save
      ? {
          name: save.name,
          content: serializeScene(save.elements, save.appState, save.files),
        }
      : this.failed;
    this.failed = null;

    if (write && this.lastSaved.get(write.name) !== write.content) {
      this.enqueueWrite(write.name, write.content);
    }
    await this.queue;
    return !this.failed;
  }

  setBaseline(name: string, content: string) {
    this.lastSaved.set(name, content);
  }

  rename(from: string, to: string) {
    const content = this.lastSaved.get(from);
    this.lastSaved.delete(from);
    if (content !== undefined) {
      this.lastSaved.set(to, content);
    }
    if (this.pending?.name === from) {
      this.pending = { ...this.pending, name: to };
    }
    if (this.failed?.name === from) {
      this.failed = { ...this.failed, name: to };
    }
  }

  /** drops anything not yet written for this drawing */
  forget(name: string) {
    this.lastSaved.delete(name);
    if (this.pending?.name === name) {
      this.pending = null;
      this.clearTimer();
    }
    if (this.failed?.name === name) {
      this.failed = null;
    }
  }

  private enqueueWrite(name: string, content: string) {
    this.inFlight++;
    this.queue = this.queue.then(async () => {
      appJotaiStore.set(drawingSaveStateAtom, { status: "saving" });
      try {
        await LocalDrawingsAPI.write(name, content);
        this.lastSaved.set(name, content);
        if (getCurrentDrawing() === name) {
          appJotaiStore.set(drawingSaveStateAtom, { status: "saved" });
        }
        bumpDrawingsRevision();
      } catch (error) {
        appJotaiStore.set(drawingSaveStateAtom, {
          status: "error",
          error: getErrorMessage(error),
        });
        if (!this.pending) {
          this.failed = { name, content };
          this.setTimer(AUTOSAVE_RETRY_DELAY);
        }
      } finally {
        this.inFlight--;
      }
    });
  }

  private setTimer(delay: number) {
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

const autosaver = new DrawingAutosaver();

/** true while the scene is being replaced, so we don't save it to the wrong file */
let isSwitchingScene = false;

/** call from the editor's onChange (when not collaborating) */
export const autosaveCurrentDrawing = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) => {
  const name = getCurrentDrawing();
  if (!name || isSwitchingScene) {
    return;
  }
  autosaver.schedule({ name, elements, appState, files });
};

export const flushDrawingAutosave = () => autosaver.flush();

export const hasUnsavedDrawingChanges = () => autosaver.hasUnsavedChanges();

const setBaselineFromScene = (api: ExcalidrawImperativeAPI, name: string) => {
  autosaver.setBaseline(
    name,
    serializeScene(
      api.getSceneElementsIncludingDeleted(),
      api.getAppState(),
      api.getFiles(),
    ),
  );
};

const flushOrThrow = async () => {
  if (!(await autosaver.flush())) {
    throw new Error(
      "Az aktuális rajz mentése nem sikerült, ezért a művelet megszakadt.",
    );
  }
};

// -----------------------------------------------------------------------------
// actions
// -----------------------------------------------------------------------------

const parseDrawing = (
  content: string,
  localAppState: AppState | null,
  localElements: readonly ExcalidrawElement[] | null,
) =>
  loadFromBlob(
    new Blob([content], { type: MIME_TYPES.excalidraw }),
    localAppState,
    localElements,
  );

/**
 * Loads a drawing for the initial scene. The viewport and UI state come from
 * `localAppState` (what the browser remembered), everything else from the file.
 */
export const loadDrawingForInitialScene = async (
  name: string,
  localAppState: Partial<AppState>,
) => {
  const content = await LocalDrawingsAPI.read(name);
  const data = await parseDrawing(content, null, null);
  autosaver.setBaseline(
    name,
    serializeScene(data.elements, data.appState, data.files),
  );
  return {
    elements: data.elements,
    // only take the drawing's own settings (background, grid, …) from the
    // file; a fully restored appState would also reset the editor's
    // dimensions & offsets
    appState: {
      ...localAppState,
      ...cleanAppStateForExport(data.appState),
      name,
    },
    files: data.files,
  };
};

export const openDrawing = async (
  api: ExcalidrawImperativeAPI,
  name: string,
) => {
  await flushOrThrow();
  const content = await LocalDrawingsAPI.read(name);
  const data = await parseDrawing(
    content,
    api.getAppState(),
    api.getSceneElementsIncludingDeleted(),
  );

  isSwitchingScene = true;
  try {
    setCurrentDrawing(name);
    api.updateScene({
      elements: data.elements,
      appState: {
        ...data.appState,
        name,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.addFiles(Object.values(data.files));
    api.history.clear();
    setBaselineFromScene(api, name);
  } finally {
    isSwitchingScene = false;
  }

  const visibleElements = getNonDeletedElements(data.elements);
  if (visibleElements.length) {
    api.setViewport({
      target: visibleElements,
      fit: "scale-down",
      animation: false,
    });
  }
};

/** creates an empty drawing and opens it */
export const createDrawing = async (api: ExcalidrawImperativeAPI) => {
  await flushOrThrow();
  const name = await LocalDrawingsAPI.create(
    DEFAULT_DRAWING_NAME,
    serializeAsJSON([], getDefaultAppState(), {}, "local"),
  );
  bumpDrawingsRevision();
  await openDrawing(api, name);
  return name;
};

/** saves the current (not yet saved) canvas as a new drawing */
export const saveCanvasAsDrawing = async (api: ExcalidrawImperativeAPI) => {
  await flushOrThrow();
  const content = serializeScene(
    api.getSceneElementsIncludingDeleted(),
    api.getAppState(),
    api.getFiles(),
  );
  const name = await LocalDrawingsAPI.create(
    sanitizeDrawingName(api.getAppState().name || ""),
    content,
  );
  autosaver.setBaseline(name, content);
  setCurrentDrawing(name);
  api.updateScene({ appState: { name } });
  bumpDrawingsRevision();
  return name;
};

/** picks a file from the disk, copies it into the drawings folder, opens it */
export const importDrawing = async (api: ExcalidrawImperativeAPI) => {
  const file = await fileOpen({
    description: "Excalidraw rajz",
    extensions: ["json", "excalidraw", "png", "svg"],
  });
  const data = await loadFromBlob(file, null, null);
  await flushOrThrow();
  const name = await LocalDrawingsAPI.create(
    sanitizeDrawingName(file.name.replace(/\.(excalidraw|json|png|svg)$/i, "")),
    serializeScene(data.elements, data.appState, data.files),
  );
  bumpDrawingsRevision();
  await openDrawing(api, name);
  return name;
};

export const renameDrawing = async (
  api: ExcalidrawImperativeAPI,
  from: string,
  to: string,
) => {
  await flushOrThrow();
  await LocalDrawingsAPI.rename(from, to);
  autosaver.rename(from, to);
  if (getCurrentDrawing() === from) {
    setCurrentDrawing(to);
    api.updateScene({ appState: { name: to } });
  }
  bumpDrawingsRevision();
};

/** moves the drawing to the trash; if it's open, the canvas gets cleared */
export const deleteDrawing = async (
  api: ExcalidrawImperativeAPI,
  name: string,
) => {
  const wasCurrent = getCurrentDrawing() === name;
  autosaver.forget(name);
  if (wasCurrent) {
    // stop saving into the file we're about to delete
    setCurrentDrawing(null);
  }
  // wait for in-flight writes, so they don't recreate the file
  await autosaver.flush();
  try {
    await LocalDrawingsAPI.remove(name);
  } catch (error) {
    if (wasCurrent) {
      setCurrentDrawing(name);
    }
    throw error;
  }
  if (wasCurrent) {
    api.resetScene();
    api.history.clear();
  }
  bumpDrawingsRevision();
};

/**
 * Unbinds the canvas from its file, e.g. when a shared link or a live
 * collaboration session replaces the scene, so it doesn't overwrite the file.
 */
export const detachCurrentDrawing = async () => {
  if (!getCurrentDrawing()) {
    return;
  }
  await autosaver.flush();
  setCurrentDrawing(null);
};

// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

export const sanitizeDrawingName = (name: string) =>
  name
    .replace(INVALID_NAME_CHARS, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, MAX_DRAWING_NAME_LENGTH) || DEFAULT_DRAWING_NAME;
