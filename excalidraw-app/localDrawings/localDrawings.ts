/**
 * Browser side of the local drawings feature: API client for the Vite plugin
 * (see `vitePlugin.ts`), app state (workspace, sidebar, current drawing),
 * autosave of the open drawing, and the actions used by the UI.
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
import { exportScene } from "@excalidraw/excalidraw/scene/export";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";

import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_WORKSPACE_NAME,
  LOCAL_DRAWINGS_API_PATH,
  MAX_NAME_LENGTH,
  parseDrawingPath,
  toDrawingPath,
} from "./constants";

import type {
  DrawingMeta,
  DrawingPath,
  RootInfo,
  TrashItem,
  WorkspaceData,
} from "./constants";

export const DEFAULT_DRAWING_NAME = "Untitled scene";

const CURRENT_DRAWING_STORAGE_KEY = "excalidraw-app-current-drawing";
const WORKSPACE_STORAGE_KEY = "excalidraw-app-workspace";
const SORT_STORAGE_KEY = "excalidraw-app-drawings-sort";
const SIDEBAR_OPEN_STORAGE_KEY = "excalidraw-app-drawings-sidebar-open";
const AUTOSAVE_DELAY = 800;
const AUTOSAVE_RETRY_DELAY = 5000;
const THUMBNAIL_DELAY = 2000;

// -----------------------------------------------------------------------------
// storage helpers
// -----------------------------------------------------------------------------

const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // localStorage unavailable/full — the value then only lives in memory
  }
};

const readStoredCurrentDrawing = (): DrawingPath | null => {
  const stored = readStorage(CURRENT_DRAWING_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  if (parseDrawingPath(stored)) {
    return stored;
  }
  // older layout stored only the name, the server has since moved the file
  // into the default workspace's default collection
  return stored.includes("/")
    ? null
    : toDrawingPath(DEFAULT_WORKSPACE_NAME, DEFAULT_COLLECTION_NAME, stored);
};

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------

/** path of the drawing the canvas is bound to (null = not saved to a file) */
export const currentDrawingPathAtom = atom<DrawingPath | null>(
  readStoredCurrentDrawing(),
);

export type DrawingSaveState =
  | { status: "idle" | "saving" | "saved" }
  | { status: "error"; error: string };

export const drawingSaveStateAtom = atom<DrawingSaveState>({ status: "idle" });

/** bumped whenever the files on disk change, so the UI re-fetches them */
export const drawingsRevisionAtom = atom(0);

/** null = not known yet, false = the API isn't reachable (e.g. static build) */
export const localDrawingsAvailableAtom = atom<boolean | null>(null);

export const rootInfoAtom = atom<RootInfo | null>(null);
export const workspaceDataAtom = atom<WorkspaceData | null>(null);
export const localDrawingsErrorAtom = atom<string | null>(null);

export const activeWorkspaceAtom = atom<string | null>(
  readStorage(WORKSPACE_STORAGE_KEY),
);

export type SortOrder = "name" | "created" | "updated";
export const sortOrderAtom = atom<SortOrder>(
  (readStorage(SORT_STORAGE_KEY) as SortOrder) || "updated",
);

export type BrowsePage =
  | { type: "dashboard" }
  | { type: "collection"; name: string }
  | { type: "trash" }
  | { type: "settings" };

export type SidebarState = {
  open: boolean;
  /** editor: the canvas with the collection list; browse: a full page */
  mode: "editor" | "browse";
  page: BrowsePage;
  /** collection listed in the sidebar in editor mode */
  collection: string | null;
};

export const sidebarStateAtom = atom<SidebarState>({
  open: readStorage(SIDEBAR_OPEN_STORAGE_KEY) !== "false",
  mode: "editor",
  page: { type: "dashboard" },
  collection:
    parseDrawingPath(readStoredCurrentDrawing() || "")?.collection ?? null,
});

export const getCurrentDrawing = () =>
  appJotaiStore.get(currentDrawingPathAtom);

export const setSidebarState = (
  update: Partial<SidebarState> | ((prev: SidebarState) => SidebarState),
) => {
  appJotaiStore.set(sidebarStateAtom, (prev) => {
    const next =
      typeof update === "function" ? update(prev) : { ...prev, ...update };
    if (next.open !== prev.open) {
      writeStorage(SIDEBAR_OPEN_STORAGE_KEY, String(next.open));
    }
    return next;
  });
};

export const setSortOrder = (order: SortOrder) => {
  appJotaiStore.set(sortOrderAtom, order);
  writeStorage(SORT_STORAGE_KEY, order);
};

export const setActiveWorkspace = (workspace: string) => {
  if (appJotaiStore.get(activeWorkspaceAtom) !== workspace) {
    appJotaiStore.set(workspaceDataAtom, null);
  }
  appJotaiStore.set(activeWorkspaceAtom, workspace);
  writeStorage(WORKSPACE_STORAGE_KEY, workspace);
  bumpDrawingsRevision();
};

const setCurrentDrawing = (path: DrawingPath | null) => {
  appJotaiStore.set(currentDrawingPathAtom, path);
  appJotaiStore.set(drawingSaveStateAtom, { status: "idle" });
  writeStorage(CURRENT_DRAWING_STORAGE_KEY, path);
  const parsed = path && parseDrawingPath(path);
  if (parsed) {
    setSidebarState({ collection: parsed.collection });
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
    appJotaiStore.set(currentDrawingPathAtom, stored);
    appJotaiStore.set(drawingSaveStateAtom, { status: "idle" });
    // show the adopted drawing in the sidebar
    const parsed = stored && parseDrawingPath(stored);
    if (parsed) {
      if (appJotaiStore.get(activeWorkspaceAtom) !== parsed.workspace) {
        setActiveWorkspace(parsed.workspace);
      }
      setSidebarState({ collection: parsed.collection });
    }
  }
};

// -----------------------------------------------------------------------------
// toasts (rendered by <LocalDrawingsDialogs />, visible over every page)
// -----------------------------------------------------------------------------

export const localToastAtom = atom<{ id: number; message: string } | null>(
  null,
);

let toastTimer: number | null = null;
export const showLocalToast = (message: string, duration = 4000) => {
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  appJotaiStore.set(localToastAtom, { id: Date.now(), message });
  toastTimer = window.setTimeout(
    () => appJotaiStore.set(localToastAtom, null),
    duration,
  );
};

export const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** runs an action, reporting failures in a toast (cancelled pickers are fine) */
export const runLocalAction = async <T>(
  action: () => Promise<T>,
): Promise<T | undefined> => {
  try {
    return await action();
  } catch (error: any) {
    if (error?.name !== "AbortError") {
      showLocalToast(getErrorMessage(error), 6000);
    }
    return undefined;
  } finally {
    bumpDrawingsRevision();
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
      "The local drawings server is not reachable. Is `yarn start` running?",
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
          ? "The local drawings server is not reachable."
          : `Server error (${response.status}).`),
      data === null ? null : response.status,
    );
  }
  return data as T;
};

const qs = (params: Record<string, string>) =>
  `?${new URLSearchParams(params).toString()}`;

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const LocalDrawingsAPI = {
  info: () => request<RootInfo>("/"),
  workspace: (workspace: string) =>
    request<WorkspaceData>(`/workspace${qs({ w: workspace })}`),
  createWorkspace: async (name: string) =>
    (await post<{ name: string }>("/workspaces", { name })).name,
  renameWorkspace: async (from: string, to: string) =>
    (await post<{ name: string }>("/workspaces/rename", { from, to })).name,
  setWorkspaceColor: (workspace: string, color: string) =>
    post("/workspaces/color", { workspace, color }),
  createCollection: async (workspace: string, name: string) =>
    (await post<{ name: string }>("/collections", { workspace, name })).name,
  renameCollection: async (workspace: string, from: string, to: string) =>
    (
      await post<{ name: string }>("/collections/rename", {
        workspace,
        from,
        to,
      })
    ).name,
  deleteCollection: (workspace: string, collection: string) =>
    request(`/collections${qs({ w: workspace, c: collection })}`, {
      method: "DELETE",
    }),
  read: async (path: DrawingPath) =>
    (await request<{ content: string }>(`/drawing${qs({ p: path })}`)).content,
  write: (path: DrawingPath, content: string) =>
    request(`/drawing${qs({ p: path })}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  create: async (
    workspace: string,
    collection: string,
    name: string,
    content: string,
  ) =>
    (
      await post<{ path: DrawingPath }>("/drawing", {
        workspace,
        collection,
        name,
        content,
      })
    ).path,
  rename: async (path: DrawingPath, name: string) =>
    (await post<{ path: DrawingPath }>("/drawing/rename", { path, name })).path,
  move: async (path: DrawingPath, collection: string) =>
    (await post<{ path: DrawingPath }>("/drawing/move", { path, collection }))
      .path,
  duplicate: async (path: DrawingPath) =>
    (await post<{ path: DrawingPath }>("/drawing/duplicate", { path })).path,
  trash: (path: DrawingPath) =>
    request(`/drawing${qs({ p: path })}`, { method: "DELETE" }),
  setPinned: (path: DrawingPath, pinned: boolean) =>
    post("/drawing/pin", { path, pinned }),
  thumbnailUrl: (path: DrawingPath, version: number) =>
    `${LOCAL_DRAWINGS_API_PATH}/thumbnail${qs({
      p: path,
      v: String(Math.round(version)),
    })}`,
  writeThumbnail: (path: DrawingPath, png: Blob) =>
    request(`/thumbnail${qs({ p: path })}`, {
      method: "PUT",
      body: png,
      headers: { "Content-Type": "image/png" },
    }),
  listTrash: async (workspace: string) =>
    (await request<{ items: TrashItem[] }>(`/trash${qs({ w: workspace })}`))
      .items,
  restore: async (workspace: string, id: string) =>
    (await post<{ path: DrawingPath }>("/trash/restore", { workspace, id }))
      .path,
  deleteFromTrash: (workspace: string, id: string | null) =>
    request(`/trash${qs(id ? { w: workspace, id } : { w: workspace })}`, {
      method: "DELETE",
    }),
  reveal: (target: { path: DrawingPath } | { workspace: string }) =>
    post("/reveal", target),
};

/** loads the workspace list and the active workspace's drawings */
export const refreshLocalDrawings = async () => {
  try {
    const info = await LocalDrawingsAPI.info();
    appJotaiStore.set(rootInfoAtom, info);
    let workspace = appJotaiStore.get(activeWorkspaceAtom);
    if (!workspace || !info.workspaces.some((ws) => ws.name === workspace)) {
      workspace =
        parseDrawingPath(getCurrentDrawing() || "")?.workspace ||
        info.workspaces[0]?.name ||
        null;
      if (workspace && !info.workspaces.some((ws) => ws.name === workspace)) {
        workspace = info.workspaces[0]?.name || null;
      }
      appJotaiStore.set(activeWorkspaceAtom, workspace);
      writeStorage(WORKSPACE_STORAGE_KEY, workspace);
    }
    if (workspace) {
      const data = await LocalDrawingsAPI.workspace(workspace);
      // ignore stale responses after a workspace switch
      if (appJotaiStore.get(activeWorkspaceAtom) === workspace) {
        appJotaiStore.set(workspaceDataAtom, data);
        queueMissingThumbnails(data);
      }
    }
    appJotaiStore.set(localDrawingsAvailableAtom, true);
    appJotaiStore.set(localDrawingsErrorAtom, null);
  } catch (error) {
    appJotaiStore.set(localDrawingsAvailableAtom, false);
    appJotaiStore.set(localDrawingsErrorAtom, getErrorMessage(error));
  }
};

// -----------------------------------------------------------------------------
// sorting & lookup helpers for the UI
// -----------------------------------------------------------------------------

export const sortDrawings = (drawings: DrawingMeta[], order: SortOrder) =>
  [...drawings].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    switch (order) {
      case "name":
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      case "created":
        return b.createdAt - a.createdAt;
      default:
        return b.modifiedAt - a.modifiedAt;
    }
  });

export const getAllDrawings = (data: WorkspaceData | null) =>
  data ? data.collections.flatMap((collection) => collection.drawings) : [];

/** where new drawings go: the collection in view, else the first one */
export const getTargetCollection = () => {
  const data = appJotaiStore.get(workspaceDataAtom);
  if (!data) {
    return null;
  }
  const sidebar = appJotaiStore.get(sidebarStateAtom);
  const candidates = [
    sidebar.mode === "browse" && sidebar.page.type === "collection"
      ? sidebar.page.name
      : null,
    sidebar.collection,
    DEFAULT_COLLECTION_NAME,
  ];
  const collection =
    candidates.find(
      (name) => name && data.collections.some((col) => col.name === name),
    ) || data.collections[0]?.name;
  return collection ? { workspace: data.name, collection } : null;
};

const requireTargetCollection = () => {
  const target = getTargetCollection();
  if (!target) {
    throw new Error("No workspace is loaded yet.");
  }
  return target;
};

// -----------------------------------------------------------------------------
// thumbnails
// -----------------------------------------------------------------------------

const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 360;

const thumbnailQueue = new Map<DrawingPath, string | null>();
const thumbnailTimers = new Map<DrawingPath, number>();
const thumbnailAttempted = new Set<DrawingPath>();
let thumbnailWorker: Promise<void> | null = null;

const renderThumbnail = async (path: DrawingPath, content: string | null) => {
  const data = await parseDrawing(
    content ?? (await LocalDrawingsAPI.read(path)),
    null,
    null,
  );
  const elements = getNonDeletedElements(data.elements);
  if (!elements.length) {
    return;
  }
  const png = await exportScene({
    type: "png",
    data: { elements, appState: data.appState, files: data.files },
    config: {
      theme: "dark",
      canvasBackgroundColor: false,
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      fit: "contain",
      padding: 24,
    },
  });
  await LocalDrawingsAPI.writeThumbnail(path, png);
  bumpDrawingsRevision();
};

const runThumbnailWorker = () => {
  thumbnailWorker =
    thumbnailWorker ||
    (async () => {
      while (thumbnailQueue.size) {
        const [path, content] = thumbnailQueue.entries().next().value!;
        thumbnailQueue.delete(path);
        try {
          await renderThumbnail(path, content);
        } catch (error) {
          console.warn(`Couldn't render the thumbnail of "${path}"`, error);
        }
      }
    })().finally(() => {
      thumbnailWorker = null;
    });
};

/** (re)renders a drawing's thumbnail, debounced per drawing */
export const scheduleThumbnail = (
  path: DrawingPath,
  content: string | null = null,
  delay = THUMBNAIL_DELAY,
) => {
  thumbnailAttempted.add(path);
  window.clearTimeout(thumbnailTimers.get(path));
  thumbnailTimers.set(
    path,
    window.setTimeout(() => {
      thumbnailTimers.delete(path);
      thumbnailQueue.set(path, content);
      runThumbnailWorker();
    }, delay),
  );
};

/** renders thumbnails that are missing or older than their drawing */
const queueMissingThumbnails = (data: WorkspaceData) => {
  for (const drawing of getAllDrawings(data)) {
    const isStale =
      drawing.thumbnailVersion === null ||
      drawing.thumbnailVersion < drawing.modifiedAt - 10_000;
    if (isStale && !thumbnailAttempted.has(drawing.path)) {
      scheduleThumbnail(drawing.path, null, 0);
    }
  }
};

// -----------------------------------------------------------------------------
// autosave
// -----------------------------------------------------------------------------

const serializeScene = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => serializeAsJSON(getNonDeletedElements(elements), appState, files, "local");

type PendingSave = {
  path: DrawingPath;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

class DrawingAutosaver {
  /** last content written (or loaded) per drawing, to skip no-op writes */
  private lastSaved = new Map<DrawingPath, string>();
  /** latest scene waiting for the debounce to elapse */
  private pending: PendingSave | null = null;
  /** content whose write failed, retried on the next flush */
  private failed: { path: DrawingPath; content: string } | null = null;
  private timer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;

  schedule(save: PendingSave) {
    this.pending = save;
    if (this.failed?.path === save.path) {
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
    const { path, elements, appState, files } = this.pending;
    return (
      this.lastSaved.get(path) !== serializeScene(elements, appState, files)
    );
  }

  /** writes pending changes now; resolves to false if a write failed */
  async flush(): Promise<boolean> {
    this.clearTimer();
    const save = this.pending;
    this.pending = null;

    const write = save
      ? {
          path: save.path,
          content: serializeScene(save.elements, save.appState, save.files),
        }
      : this.failed;
    this.failed = null;

    if (write && this.lastSaved.get(write.path) !== write.content) {
      this.enqueueWrite(write.path, write.content);
    }
    await this.queue;
    return !this.failed;
  }

  setBaseline(path: DrawingPath, content: string) {
    this.lastSaved.set(path, content);
  }

  /** follows a rename/move of drawings whose path starts with `from` */
  renamePrefix(from: string, to: string) {
    const rename = (path: DrawingPath) =>
      path === from || path.startsWith(`${from}/`)
        ? `${to}${path.slice(from.length)}`
        : path;
    this.lastSaved = new Map(
      [...this.lastSaved].map(([path, content]) => [rename(path), content]),
    );
    if (this.pending) {
      this.pending = { ...this.pending, path: rename(this.pending.path) };
    }
    if (this.failed) {
      this.failed = { ...this.failed, path: rename(this.failed.path) };
    }
  }

  /** drops anything not yet written for this drawing */
  forget(path: DrawingPath) {
    this.lastSaved.delete(path);
    if (this.pending?.path === path) {
      this.pending = null;
      this.clearTimer();
    }
    if (this.failed?.path === path) {
      this.failed = null;
    }
  }

  private enqueueWrite(path: DrawingPath, content: string) {
    this.inFlight++;
    this.queue = this.queue.then(async () => {
      appJotaiStore.set(drawingSaveStateAtom, { status: "saving" });
      try {
        await LocalDrawingsAPI.write(path, content);
        this.lastSaved.set(path, content);
        if (getCurrentDrawing() === path) {
          appJotaiStore.set(drawingSaveStateAtom, { status: "saved" });
        }
        scheduleThumbnail(path, content);
        bumpDrawingsRevision();
      } catch (error) {
        appJotaiStore.set(drawingSaveStateAtom, {
          status: "error",
          error: getErrorMessage(error),
        });
        if (!this.pending) {
          this.failed = { path, content };
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
  const path = getCurrentDrawing();
  if (!path || isSwitchingScene) {
    return;
  }
  autosaver.schedule({ path, elements, appState, files });
};

export const flushDrawingAutosave = () => autosaver.flush();

export const hasUnsavedDrawingChanges = () => autosaver.hasUnsavedChanges();

const setBaselineFromScene = (api: ExcalidrawImperativeAPI, path: string) => {
  autosaver.setBaseline(
    path,
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
      "Couldn't save the current drawing, so the action was cancelled.",
    );
  }
};

/** keeps the open drawing bound to its file after a rename/move */
const followPathChange = (
  api: ExcalidrawImperativeAPI | null,
  from: string,
  to: string,
) => {
  autosaver.renamePrefix(from, to);
  const current = getCurrentDrawing();
  if (current && (current === from || current.startsWith(`${from}/`))) {
    const next = `${to}${current.slice(from.length)}`;
    setCurrentDrawing(next);
    const name = parseDrawingPath(next)?.name;
    if (api && name) {
      api.updateScene({ appState: { name } });
    }
  }
};

// -----------------------------------------------------------------------------
// drawing actions
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
  path: DrawingPath,
  localAppState: Partial<AppState>,
) => {
  const content = await LocalDrawingsAPI.read(path);
  const data = await parseDrawing(content, null, null);
  autosaver.setBaseline(
    path,
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
      name: parseDrawingPath(path)?.name,
    },
    files: data.files,
  };
};

export const openDrawing = async (
  api: ExcalidrawImperativeAPI,
  path: DrawingPath,
) => {
  setSidebarState({ mode: "editor" });
  if (path === getCurrentDrawing()) {
    return;
  }
  await flushOrThrow();
  const content = await LocalDrawingsAPI.read(path);
  const data = await parseDrawing(
    content,
    api.getAppState(),
    api.getSceneElementsIncludingDeleted(),
  );

  isSwitchingScene = true;
  try {
    setCurrentDrawing(path);
    api.updateScene({
      elements: data.elements,
      appState: {
        ...data.appState,
        name: parseDrawingPath(path)!.name,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.addFiles(Object.values(data.files));
    api.history.clear();
    setBaselineFromScene(api, path);
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

/** creates an empty drawing in the given collection and opens it */
export const createDrawing = async (
  api: ExcalidrawImperativeAPI,
  target = requireTargetCollection(),
) => {
  await flushOrThrow();
  const path = await LocalDrawingsAPI.create(
    target.workspace,
    target.collection,
    DEFAULT_DRAWING_NAME,
    serializeAsJSON([], getDefaultAppState(), {}, "local"),
  );
  await openDrawing(api, path);
  return path;
};

/** saves the current (not yet saved) canvas as a new drawing */
export const saveCanvasAsDrawing = async (
  api: ExcalidrawImperativeAPI,
  target = requireTargetCollection(),
) => {
  await flushOrThrow();
  const content = serializeScene(
    api.getSceneElementsIncludingDeleted(),
    api.getAppState(),
    api.getFiles(),
  );
  const path = await LocalDrawingsAPI.create(
    target.workspace,
    target.collection,
    sanitizeName(api.getAppState().name || ""),
    content,
  );
  autosaver.setBaseline(path, content);
  setCurrentDrawing(path);
  api.updateScene({ appState: { name: parseDrawingPath(path)!.name } });
  scheduleThumbnail(path, content, 0);
  return path;
};

/** picks files from the disk and copies them into a collection */
export const importDrawings = async (
  api: ExcalidrawImperativeAPI,
  target = requireTargetCollection(),
  { multiple = true } = {},
) => {
  const picked = await fileOpen({
    description: "Excalidraw scene",
    extensions: ["json", "excalidraw", "png", "svg"],
    multiple: true,
  });
  return importFiles(api, multiple ? picked : picked.slice(0, 1), target);
};

/** creates a drawing from each file and opens the first one */
const importFiles = async (
  api: ExcalidrawImperativeAPI,
  files: readonly File[],
  target: { workspace: string; collection: string },
) => {
  const paths: DrawingPath[] = [];
  for (const file of files) {
    const data = await loadFromBlob(file, null, null);
    const content = serializeScene(data.elements, data.appState, data.files);
    const path = await LocalDrawingsAPI.create(
      target.workspace,
      target.collection,
      sanitizeName(file.name.replace(/\.(excalidraw|json|png|svg)$/i, "")),
      content,
    );
    scheduleThumbnail(path, content, 0);
    paths.push(path);
  }
  if (paths.length) {
    await openDrawing(api, paths[0]);
  }
  return paths;
};

/**
 * Opens a file handed over by the OS (desktop app, e.g. a double click in
 * Finder): drawings inside the drawings folder open in place, other files get
 * imported as new drawings.
 */
export const openExternalFile = async (
  api: ExcalidrawImperativeAPI,
  file: { name: string; content: string; drawingPath: DrawingPath | null },
) => {
  await refreshLocalDrawings();
  const parsed = file.drawingPath && parseDrawingPath(file.drawingPath);
  if (parsed) {
    if (appJotaiStore.get(activeWorkspaceAtom) !== parsed.workspace) {
      setActiveWorkspace(parsed.workspace);
    }
    await openDrawing(api, file.drawingPath!);
    return [file.drawingPath!];
  }
  return importFiles(
    api,
    [new File([file.content], file.name, { type: "application/json" })],
    requireTargetCollection(),
  );
};

export const renameDrawing = async (
  api: ExcalidrawImperativeAPI | null,
  path: DrawingPath,
  newName: string,
) => {
  await flushOrThrow();
  const newPath = await LocalDrawingsAPI.rename(path, newName);
  followPathChange(api, path, newPath);
  return newPath;
};

export const moveDrawing = async (
  api: ExcalidrawImperativeAPI | null,
  path: DrawingPath,
  collection: string,
) => {
  await flushOrThrow();
  const newPath = await LocalDrawingsAPI.move(path, collection);
  followPathChange(api, path, newPath);
  return newPath;
};

export const duplicateDrawing = async (path: DrawingPath) => {
  await flushOrThrow();
  return LocalDrawingsAPI.duplicate(path);
};

/** moves the drawing to the trash; if it's open, the canvas gets cleared */
export const trashDrawing = async (
  api: ExcalidrawImperativeAPI | null,
  path: DrawingPath,
) => {
  const wasCurrent = getCurrentDrawing() === path;
  autosaver.forget(path);
  if (wasCurrent) {
    // stop saving into the file we're about to delete
    setCurrentDrawing(null);
  }
  // wait for in-flight writes, so they don't recreate the file
  await autosaver.flush();
  try {
    await LocalDrawingsAPI.trash(path);
  } catch (error) {
    if (wasCurrent) {
      setCurrentDrawing(path);
    }
    throw error;
  }
  if (wasCurrent && api) {
    api.resetScene();
    api.history.clear();
  }
};

export const exportDrawing = async (
  path: DrawingPath,
  type: "png" | "svg" | "excalidraw",
) => {
  const name = parseDrawingPath(path)!.name;
  const content = await LocalDrawingsAPI.read(path);
  let blob: Blob;
  if (type === "excalidraw") {
    blob = new Blob([content], { type: MIME_TYPES.excalidraw });
  } else {
    const data = await parseDrawing(content, null, null);
    const exportData = {
      elements: getNonDeletedElements(data.elements),
      appState: data.appState,
      files: data.files,
    };
    if (type === "png") {
      blob = await exportScene({
        type: "png",
        data: exportData,
        config: { scale: 2 },
      });
    } else {
      const svg = await exportScene({ type: "svg", data: exportData });
      blob = new Blob([svg.outerHTML], { type: MIME_TYPES.svg });
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.${type}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// -----------------------------------------------------------------------------
// workspace & collection actions
// -----------------------------------------------------------------------------

export const createWorkspace = async (name: string) => {
  const created = await LocalDrawingsAPI.createWorkspace(name);
  setActiveWorkspace(created);
  setSidebarState({
    mode: "browse",
    page: { type: "collection", name: DEFAULT_COLLECTION_NAME },
  });
  return created;
};

export const renameWorkspace = async (
  api: ExcalidrawImperativeAPI | null,
  from: string,
  to: string,
) => {
  await flushOrThrow();
  const renamed = await LocalDrawingsAPI.renameWorkspace(from, to);
  followPathChange(api, from, renamed);
  if (appJotaiStore.get(activeWorkspaceAtom) === from) {
    setActiveWorkspace(renamed);
  }
  return renamed;
};

export const createCollection = async (workspace: string, name: string) => {
  const created = await LocalDrawingsAPI.createCollection(workspace, name);
  setSidebarState({
    mode: "browse",
    page: { type: "collection", name: created },
  });
  return created;
};

export const renameCollection = async (
  api: ExcalidrawImperativeAPI | null,
  workspace: string,
  from: string,
  to: string,
) => {
  await flushOrThrow();
  const renamed = await LocalDrawingsAPI.renameCollection(workspace, from, to);
  followPathChange(api, `${workspace}/${from}`, `${workspace}/${renamed}`);
  setSidebarState((prev) => ({
    ...prev,
    collection: prev.collection === from ? renamed : prev.collection,
    page:
      prev.page.type === "collection" && prev.page.name === from
        ? { type: "collection", name: renamed }
        : prev.page,
  }));
  return renamed;
};

export const deleteCollection = async (workspace: string, name: string) => {
  await LocalDrawingsAPI.deleteCollection(workspace, name);
  setSidebarState((prev) => ({
    ...prev,
    collection: prev.collection === name ? null : prev.collection,
    page:
      prev.page.type === "collection" && prev.page.name === name
        ? { type: "dashboard" }
        : prev.page,
  }));
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

export const sanitizeName = (name: string, fallback = DEFAULT_DRAWING_NAME) =>
  name
    .replace(INVALID_NAME_CHARS, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH) || fallback;

export const isValidName = (name: string) =>
  !!name.trim() && sanitizeName(name.trim(), "") === name.trim();

export const INVALID_NAME_MESSAGE =
  "Names can't start with a dot or contain any of: \\ / : * ? \" < > |";
