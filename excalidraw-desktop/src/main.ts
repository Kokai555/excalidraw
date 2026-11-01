/**
 * Electron main process of the desktop app.
 *
 * The web app (built into `web/` with VITE_APP_DESKTOP=true) and the local
 * drawings API (`excalidraw-app/localDrawings/server.ts`) are both served from
 * the privileged `app://excalidraw` protocol, so nothing listens on a network
 * port and the app keeps a stable origin (its localStorage & IndexedDB).
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  protocol,
  screen,
  shell,
} from "electron";

import {
  DRAWING_FILE_EXTENSION,
  LOCAL_DRAWINGS_API_PATH,
  toDrawingPath,
} from "../../excalidraw-app/localDrawings/constants";
import {
  createLocalDrawingsHandler,
  resolveDrawingsDir,
  tooLargeError,
} from "../../excalidraw-app/localDrawings/server";

import type { MenuItemConstructorOptions, Rectangle } from "electron";

const SCHEME = "app";
const HOST = "excalidraw";
const APP_URL = `${SCHEME}://${HOST}/`;

const WEB_ROOT = path.join(__dirname, "..", "web");
const DRAWINGS_ROOT = resolveDrawingsDir(process.env.EXCALIDRAW_DRAWINGS_DIR);
const WINDOW_STATE_FILE = () =>
  path.join(app.getPath("userData"), "window-state.json");

/** how long closing the window waits for the drawing to be saved */
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_OPEN_FILE_BYTES = 200 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

// must happen before the app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// -----------------------------------------------------------------------------
// app:// protocol (static files + local drawings API)
// -----------------------------------------------------------------------------

const handleApi = createLocalDrawingsHandler(DRAWINGS_ROOT);

const serveApi = async (request: Request, url: URL) => {
  const response = await handleApi({
    method: request.method,
    url: url.pathname.slice(LOCAL_DRAWINGS_API_PATH.length) + url.search,
    readBody: async (limit) => {
      const length = Number(request.headers.get("content-length"));
      if (length > limit) {
        throw tooLargeError();
      }
      const body = Buffer.from(await request.arrayBuffer());
      if (body.length > limit) {
        throw tooLargeError();
      }
      return body;
    },
  });
  return new Response(new Uint8Array(Buffer.from(response.body)), {
    status: response.status,
    headers: response.headers,
  });
};

const isFile = async (filePath: string) => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const serveStatic = async (url: URL) => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  let filePath = path.join(WEB_ROOT, path.normalize(pathname));
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  if (!(await isFile(filePath))) {
    // the app has a single page; unknown extension-less paths get it too
    if (path.extname(filePath)) {
      return new Response("Not found", { status: 404 });
    }
    filePath = path.join(WEB_ROOT, "index.html");
  }
  const body = await fs.readFile(filePath);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type":
        MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
    },
  });
};

const registerAppProtocol = () => {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response("Not found", { status: 404 });
    }
    try {
      if (
        url.pathname === LOCAL_DRAWINGS_API_PATH ||
        url.pathname.startsWith(`${LOCAL_DRAWINGS_API_PATH}/`)
      ) {
        return await serveApi(request, url);
      }
      return await serveStatic(url);
    } catch (error: any) {
      console.error("[app protocol]", error);
      return new Response(String(error?.message || error), { status: 500 });
    }
  });
};

// -----------------------------------------------------------------------------
// window state
// -----------------------------------------------------------------------------

type WindowState = { bounds?: Rectangle; maximized?: boolean };

const readWindowState = async (): Promise<WindowState> => {
  try {
    const state = JSON.parse(await fs.readFile(WINDOW_STATE_FILE(), "utf8"));
    const bounds: Rectangle | undefined = state?.bounds;
    // forget the position if its display is gone
    const visible =
      bounds &&
      screen.getAllDisplays().some(({ workArea }) => {
        return (
          bounds.x < workArea.x + workArea.width &&
          bounds.x + bounds.width > workArea.x &&
          bounds.y < workArea.y + workArea.height &&
          bounds.y + bounds.height > workArea.y
        );
      });
    return {
      bounds: visible ? bounds : undefined,
      maximized: !!state?.maximized,
    };
  } catch {
    return {};
  }
};

const saveWindowState = async (win: BrowserWindow) => {
  const state: WindowState = {
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
  };
  try {
    await fs.mkdir(path.dirname(WINDOW_STATE_FILE()), { recursive: true });
    await fs.writeFile(WINDOW_STATE_FILE(), JSON.stringify(state));
  } catch (error) {
    console.error("Couldn't save the window state", error);
  }
};

// -----------------------------------------------------------------------------
// talking to the page (see excalidraw-app/localDrawings/desktop.ts)
// -----------------------------------------------------------------------------

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

/** saves the open drawing; resolves to false if that failed or timed out */
const flushPage = (win: BrowserWindow): Promise<boolean> => {
  if (win.webContents.isLoading() || win.webContents.isCrashed()) {
    return Promise.resolve(true);
  }
  return withTimeout(
    win.webContents
      .executeJavaScript(
        `(async () => {
          const desktop = window.__EXCALIDRAW_DESKTOP__;
          if (!desktop) return true;
          // the scene isn't loaded yet → nothing to save
          const bridge = await Promise.race([
            desktop.ready(),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
          return bridge ? bridge.flush() : true;
        })()`,
      )
      .then((result) => result !== false)
      .catch(() => false),
    FLUSH_TIMEOUT_MS,
    false,
  );
};

const confirmLosingChanges = async (win: BrowserWindow, action: string) => {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: [action, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "The open drawing couldn't be saved.",
    detail: `Its latest changes will be lost if you continue. The drawings are stored in ${DRAWINGS_ROOT}.`,
  });
  return response === 0;
};

const realpathOrSelf = (filePath: string) =>
  fs.realpath(filePath).catch(() => filePath);

/** the drawing's path (`workspace/collection/name`) if the file is a drawing */
const toDrawingPathIfInRoot = async (filePath: string) => {
  // compare resolved paths (e.g. /tmp is a symlink to /private/tmp on macOS)
  const relative = path.relative(
    await realpathOrSelf(DRAWINGS_ROOT),
    await realpathOrSelf(filePath),
  );
  const parts = relative.split(path.sep);
  if (
    parts.length !== 3 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    parts.some((part) => part.startsWith(".")) ||
    !parts[2].endsWith(DRAWING_FILE_EXTENSION)
  ) {
    return null;
  }
  return toDrawingPath(
    parts[0],
    parts[1],
    parts[2].slice(0, -DRAWING_FILE_EXTENSION.length),
  );
};

const openFileInPage = async (win: BrowserWindow, filePath: string) => {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_OPEN_FILE_BYTES) {
      throw new Error("The file is too large.");
    }
    const payload = {
      name: path.basename(filePath),
      content: await fs.readFile(filePath, "utf8"),
      drawingPath: await toDrawingPathIfInRoot(filePath),
    };
    await win.webContents.executeJavaScript(
      `window.__EXCALIDRAW_DESKTOP__.ready().then((bridge) => bridge.openFile(${JSON.stringify(
        payload,
      )}))`,
    );
  } catch (error: any) {
    dialog.showMessageBox(win, {
      type: "error",
      message: `Couldn't open ${path.basename(filePath)}`,
      detail: String(error?.message || error),
    });
  }
};

// -----------------------------------------------------------------------------
// window
// -----------------------------------------------------------------------------

let windowPromise: Promise<BrowserWindow> | null = null;
let isQuitting = false;
/** files opened (e.g. from Finder) before the app was ready */
const pendingFiles: string[] = [];

const isAppUrl = (url: string) => url.startsWith(APP_URL);

const openExternally = (url: string) => {
  if (/^(https?|mailto):/i.test(url)) {
    shell.openExternal(url);
  }
};

const createWindow = async () => {
  const state = await readWindowState();
  const win = new BrowserWindow({
    title: "Excalidraw",
    width: state.bounds?.width ?? 1440,
    height: state.bounds?.height ?? 900,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#121212",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (state.maximized) {
    win.maximize();
  }

  win.once("ready-to-show", () => win.show());

  // links leave the app for the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternally(url);
    }
  });
  // pending changes are saved before closing/reloading (see below), so the
  // page's "unsaved changes" prompt isn't needed
  win.webContents.on("will-prevent-unload", (event) => event.preventDefault());

  let closeConfirmed = false;
  let isClosing = false;
  win.on("close", (event) => {
    if (closeConfirmed) {
      saveWindowState(win);
      return;
    }
    event.preventDefault();
    if (isClosing) {
      return;
    }
    isClosing = true;
    flushPage(win).then(async (saved) => {
      isClosing = false;
      if (!saved && !(await confirmLosingChanges(win, "Close anyway"))) {
        isQuitting = false;
        return;
      }
      closeConfirmed = true;
      // `close` also gets here while quitting; quitting again continues
      if (isQuitting) {
        app.quit();
      } else {
        win.close();
      }
    });
  });
  win.on("closed", () => {
    windowPromise = null;
  });

  win.loadURL(APP_URL);
  return win;
};

/** the app's single window (created on demand) */
const getWindow = () => {
  windowPromise = windowPromise || createWindow();
  return windowPromise;
};

const focusWindow = (win: BrowserWindow) => {
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
};

const openFile = async (filePath: string) => {
  if (!app.isReady()) {
    pendingFiles.push(filePath);
    return;
  }
  const win = await getWindow();
  focusWindow(win);
  // runs once the page has loaded
  openFileInPage(win, filePath);
};

const reloadWindow = async (win: BrowserWindow) => {
  if (
    (await flushPage(win)) ||
    (await confirmLosingChanges(win, "Reload anyway"))
  ) {
    win.webContents.reload();
  }
};

// -----------------------------------------------------------------------------
// menu
// -----------------------------------------------------------------------------

const buildMenu = () => {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        {
          label: "Open File…",
          click: async () => {
            const win = await getWindow();
            const { canceled, filePaths } = await dialog.showOpenDialog(win, {
              properties: ["openFile", "multiSelections"],
              filters: [
                { name: "Excalidraw drawings", extensions: ["excalidraw"] },
              ],
            });
            if (!canceled) {
              for (const filePath of filePaths) {
                openFile(filePath);
              }
            }
          },
        },
        {
          label: "Show Drawings Folder",
          click: async () => {
            await fs.mkdir(DRAWINGS_ROOT, { recursive: true });
            shell.openPath(DRAWINGS_ROOT);
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    // undo/redo/copy/paste reach the page first; it handles them on the canvas
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: (_item, win) => {
            if (win instanceof BrowserWindow) {
              reloadWindow(win);
            }
          },
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Excalidraw on GitHub",
          click: () =>
            shell.openExternal("https://github.com/excalidraw/excalidraw"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// -----------------------------------------------------------------------------
// lifecycle
// -----------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Finder (double click, "Open With", dropping on the Dock icon)
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openFile(filePath);
  });

  app.on("second-instance", async () => {
    focusWindow(await getWindow());
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  // macOS apps stay open without windows
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    getWindow();
  });

  app.whenReady().then(() => {
    // dark title bar, menus & dialogs to match the editor
    nativeTheme.themeSource = "dark";
    app.setAboutPanelOptions({
      applicationName: "Excalidraw",
      applicationVersion: app.getVersion(),
      credits: `Drawings folder: ${DRAWINGS_ROOT}`,
    });
    registerAppProtocol();
    buildMenu();
    getWindow();
    for (const filePath of pendingFiles.splice(0)) {
      openFile(filePath);
    }
  });
}
