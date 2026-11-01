/// <reference types="node" />

/**
 * Vite plugin that exposes a small REST API for storing drawings as
 * `.excalidraw` files on the local disk:
 *
 *   <root>/<workspace>/<collection>/<name>.excalidraw
 *   <root>/<workspace>/.thumbnails/<collection>/<name>.png
 *   <root>/<workspace>/.trash/<id>.excalidraw (+ <id>.json)
 *   <root>/<workspace>/.workspace.json   (color, pins, creation times)
 *
 * Mounted on both the dev server (`yarn start`) and the preview server.
 * Only requests coming from the app itself (same origin, localhost) are
 * accepted, so other websites open in the browser can't read or write
 * the drawings.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_WORKSPACE_NAME,
  DRAWING_FILE_EXTENSION,
  LOCAL_DRAWINGS_API_PATH,
  MAX_NAME_LENGTH,
  parseDrawingPath,
  toDrawingPath,
} from "./constants";

import type {
  CollectionInfo,
  DrawingMeta,
  LocalUser,
  RootInfo,
  TrashItem,
  WorkspaceData,
} from "./constants";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const THUMBNAILS_DIR = ".thumbnails";
const TRASH_DIR = ".trash";
const META_FILE = ".workspace.json";
const MAX_BODY_BYTES = 200 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const WORKSPACE_COLORS = [
  "#d63864",
  "#e8590c",
  "#2f9e44",
  "#1971c2",
  "#7048e8",
  "#c2255c",
  "#0c8599",
  "#f08c00",
];

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type WorkspaceMeta = {
  color?: string;
  /** "<collection>/<name>" */
  pinned: string[];
  /** "<collection>/<name>" → creation time (ms); survives atomic writes */
  created: Record<string, number>;
};

export const resolveDrawingsDir = (dir?: string) => {
  if (!dir) {
    return path.join(os.homedir(), "Documents", "Excalidraw");
  }
  if (dir === "~" || dir.startsWith("~/")) {
    return path.join(os.homedir(), dir.slice(1));
  }
  return path.resolve(dir);
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const validateName = (raw: unknown, what = "name"): string => {
  if (typeof raw !== "string") {
    throw new HttpError(400, `Missing ${what}.`);
  }
  const name = raw.normalize("NFC").trim();
  if (!name) {
    throw new HttpError(400, `The ${what} can't be empty.`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `The ${what} is too long.`);
  }
  if (name.startsWith(".") || INVALID_NAME_CHARS.test(name)) {
    throw new HttpError(
      400,
      `The ${what} can't start with a dot or contain any of: \\ / : * ? " < > |`,
    );
  }
  return name;
};

const validatePath = (raw: unknown) => {
  const parsed = typeof raw === "string" ? parseDrawingPath(raw) : null;
  if (!parsed) {
    throw new HttpError(400, "Invalid drawing path.");
  }
  return {
    workspace: validateName(parsed.workspace, "workspace name"),
    collection: validateName(parsed.collection, "collection name"),
    name: validateName(parsed.name),
  };
};

const validateContent = (content: unknown): string => {
  if (typeof content !== "string") {
    throw new HttpError(400, "Missing content.");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new HttpError(400, "The content is not valid JSON.");
  }
  if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
    throw new HttpError(400, "The content is not an Excalidraw drawing.");
  }
  return content;
};

const isNotFound = (error: any) => error?.code === "ENOENT";

const exists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: any) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
};

const listDirs = async (dir: string) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name.normalize("NFC"));
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
};

const listDrawingFiles = async (dir: string) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          entry.name.endsWith(DRAWING_FILE_EXTENSION),
      )
      .map((entry) =>
        entry.name.slice(0, -DRAWING_FILE_EXTENSION.length).normalize("NFC"),
      );
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
};

const statOrNull = async (filePath: string) => {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
};

const collectionSort = (a: string, b: string) => {
  if (a === DEFAULT_COLLECTION_NAME) {
    return -1;
  }
  if (b === DEFAULT_COLLECTION_NAME) {
    return 1;
  }
  return a.localeCompare(b);
};

const hashColor = (name: string) => {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length];
};

const execFileText = (file: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(file, args, { timeout: 3000 }, (error, stdout) =>
      resolve(error ? null : stdout.toString().trim() || null),
    );
  });

let userPromise: Promise<LocalUser> | null = null;
/** the git identity (falls back to the OS user name) */
const getLocalUser = () => {
  userPromise =
    userPromise ||
    Promise.all([
      execFileText("git", ["config", "--global", "user.name"]),
      execFileText("git", ["config", "--global", "user.email"]),
    ]).then(([name, email]) => ({
      name: name || os.userInfo().username,
      email,
    }));
  return userPromise;
};

/**
 * Only accept requests the app itself makes: the server must be reached via
 * localhost (guards against DNS rebinding) and the request must not come from
 * another origin (guards against other websites calling the API).
 */
const assertTrustedRequest = (req: IncomingMessage) => {
  const host = req.headers.host || "";
  if (!LOCAL_HOST_RE.test(host)) {
    throw new HttpError(403, "Only available via localhost.");
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // invalid origin header
    }
    if (originHost !== host) {
      throw new HttpError(403, "Cross-origin requests are not allowed.");
    }
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  }
};

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "The request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const readJsonBody = async (req: IncomingMessage): Promise<any> => {
  const body = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
};

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
};

// -----------------------------------------------------------------------------
// store
// -----------------------------------------------------------------------------

const createStore = (root: string) => {
  const wsDir = (workspace: string) => path.join(root, workspace);
  const colDir = (workspace: string, collection: string) =>
    path.join(root, workspace, collection);
  const drawingFile = (workspace: string, collection: string, name: string) =>
    path.join(root, workspace, collection, `${name}${DRAWING_FILE_EXTENSION}`);
  const thumbnailFile = (workspace: string, collection: string, name: string) =>
    path.join(root, workspace, THUMBNAILS_DIR, collection, `${name}.png`);
  const trashDir = (workspace: string) => path.join(root, workspace, TRASH_DIR);
  const metaKey = (collection: string, name: string) => `${collection}/${name}`;

  const assertWorkspace = async (workspace: string) => {
    if (!(await exists(wsDir(workspace)))) {
      throw new HttpError(404, `Workspace "${workspace}" not found.`);
    }
  };

  const assertCollection = async (workspace: string, collection: string) => {
    if (!(await exists(colDir(workspace, collection)))) {
      throw new HttpError(404, `Collection "${collection}" not found.`);
    }
  };

  const assertDrawing = async (
    workspace: string,
    collection: string,
    name: string,
  ) => {
    if (!(await exists(drawingFile(workspace, collection, name)))) {
      throw new HttpError(404, `Drawing "${name}" not found.`);
    }
  };

  /** write to a temp file and rename, so a crash never leaves half a file */
  const writeAtomic = async (filePath: string, data: string | Buffer) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(tmpPath, data);
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      throw error;
    }
  };

  // --- workspace meta (updates serialized per workspace) ---------------------

  const metaQueues = new Map<string, Promise<unknown>>();

  const readMeta = async (workspace: string): Promise<WorkspaceMeta> => {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(wsDir(workspace), META_FILE), "utf8"),
      );
      return {
        color: typeof raw.color === "string" ? raw.color : undefined,
        pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
        created:
          raw.created && typeof raw.created === "object" ? raw.created : {},
      };
    } catch {
      return { pinned: [], created: {} };
    }
  };

  const updateMeta = <T>(
    workspace: string,
    update: (meta: WorkspaceMeta) => T,
  ): Promise<T> => {
    const run = async () => {
      const meta = await readMeta(workspace);
      const result = update(meta);
      await writeAtomic(
        path.join(wsDir(workspace), META_FILE),
        JSON.stringify(meta, null, 2),
      );
      return result;
    };
    const next = (metaQueues.get(workspace) || Promise.resolve()).then(
      run,
      run,
    );
    metaQueues.set(
      workspace,
      next.catch(() => {}),
    );
    return next;
  };

  const renameMetaKey = (meta: WorkspaceMeta, from: string, to: string) => {
    meta.pinned = meta.pinned.map((key) => (key === from ? to : key));
    if (from in meta.created) {
      meta.created[to] = meta.created[from];
      delete meta.created[from];
    }
  };

  const removeMetaKey = (meta: WorkspaceMeta, key: string) => {
    meta.pinned = meta.pinned.filter((pinned) => pinned !== key);
    delete meta.created[key];
  };

  // --- names ----------------------------------------------------------------

  /** "Name", "Name 2", "Name 3", … — the first one `isTaken` rejects */
  const findFreeName = async (
    baseName: string,
    isTaken: (name: string) => Promise<boolean>,
  ) => {
    for (let i = 1; i < 1000; i++) {
      const suffix = i === 1 ? "" : ` ${i}`;
      const name = `${baseName.slice(
        0,
        MAX_NAME_LENGTH - suffix.length,
      )}${suffix}`;
      if (!(await isTaken(name))) {
        return name;
      }
    }
    throw new HttpError(409, "Couldn't find a free name.");
  };

  const moveIfExists = async (from: string, to: string) => {
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  };

  // --- migration --------------------------------------------------------------

  let ensurePromise: Promise<void> | null = null;

  /**
   * Makes sure there's at least one workspace with a collection, and moves
   * drawings saved directly in the root folder (older layout) into it.
   */
  const ensureRoot = () => {
    ensurePromise =
      ensurePromise ||
      (async () => {
        await fs.mkdir(root, { recursive: true });
        let workspaces = await listDirs(root);
        if (!workspaces.length) {
          await fs.mkdir(
            colDir(DEFAULT_WORKSPACE_NAME, DEFAULT_COLLECTION_NAME),
            { recursive: true },
          );
          workspaces = [DEFAULT_WORKSPACE_NAME];
        }
        const looseDrawings = await listDrawingFiles(root);
        if (looseDrawings.length) {
          const workspace = workspaces.sort()[0];
          const collection =
            (await listDirs(wsDir(workspace))).sort(collectionSort)[0] ||
            DEFAULT_COLLECTION_NAME;
          await fs.mkdir(colDir(workspace, collection), { recursive: true });
          for (const name of looseDrawings) {
            const target = await findFreeName(name, (candidate) =>
              exists(drawingFile(workspace, collection, candidate)),
            );
            await fs.rename(
              path.join(root, `${name}${DRAWING_FILE_EXTENSION}`),
              drawingFile(workspace, collection, target),
            );
          }
        }
      })().finally(() => {
        ensurePromise = null;
      });
    return ensurePromise;
  };

  // --- drawings ---------------------------------------------------------------

  const read = async (p: string) => {
    const { workspace, collection, name } = validatePath(p);
    try {
      return await fs.readFile(
        drawingFile(workspace, collection, name),
        "utf8",
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new HttpError(404, `Drawing "${name}" not found.`);
      }
      throw error;
    }
  };

  const create = async (
    workspace: string,
    collection: string,
    baseName: string,
    content: string,
  ) => {
    await assertCollection(workspace, collection);
    for (let i = 1; i < 1000; i++) {
      const suffix = i === 1 ? "" : ` ${i}`;
      const name = `${baseName.slice(
        0,
        MAX_NAME_LENGTH - suffix.length,
      )}${suffix}`;
      try {
        // "wx" fails if the file exists, so we never overwrite anything
        await fs.writeFile(drawingFile(workspace, collection, name), content, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error: any) {
        if (error?.code === "EEXIST") {
          continue;
        }
        throw error;
      }
      const now = Date.now();
      await updateMeta(workspace, (meta) => {
        meta.created[metaKey(collection, name)] = now;
      });
      return toDrawingPath(workspace, collection, name);
    }
    throw new HttpError(409, "Couldn't find a free name.");
  };

  const listTrash = async (workspace: string): Promise<TrashItem[]> => {
    await assertWorkspace(workspace);
    let entries: string[];
    try {
      entries = await fs.readdir(trashDir(workspace));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
    const items: TrashItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(DRAWING_FILE_EXTENSION)) {
        continue;
      }
      const id = entry.slice(0, -DRAWING_FILE_EXTENSION.length);
      try {
        const info = JSON.parse(
          await fs.readFile(
            path.join(trashDir(workspace), `${id}.json`),
            "utf8",
          ),
        );
        items.push({
          id,
          collection: info.collection,
          name: info.name,
          deletedAt: info.deletedAt,
        });
      } catch {
        // trash entry without info (e.g. put there by hand)
        const stat = await statOrNull(path.join(trashDir(workspace), entry));
        items.push({
          id,
          collection: DEFAULT_COLLECTION_NAME,
          name: id,
          deletedAt: stat?.mtimeMs || 0,
        });
      }
    }
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  };

  return {
    async info(): Promise<RootInfo> {
      await ensureRoot();
      const names = (await listDirs(root)).sort((a, b) => a.localeCompare(b));
      const workspaces = await Promise.all(
        names.map(async (name) => ({
          name,
          color: (await readMeta(name)).color || hashColor(name),
        })),
      );
      return { root, user: await getLocalUser(), workspaces };
    },

    async workspace(workspace: string): Promise<WorkspaceData> {
      await ensureRoot();
      await assertWorkspace(workspace);
      const meta = await readMeta(workspace);
      const missingCreated: Record<string, number> = {};
      const collections: CollectionInfo[] = [];

      for (const collection of (await listDirs(wsDir(workspace))).sort(
        collectionSort,
      )) {
        const drawings: DrawingMeta[] = [];
        for (const name of await listDrawingFiles(
          colDir(workspace, collection),
        )) {
          const stat = await statOrNull(
            drawingFile(workspace, collection, name),
          );
          if (!stat) {
            continue;
          }
          const key = metaKey(collection, name);
          let createdAt = meta.created[key];
          if (typeof createdAt !== "number") {
            createdAt = Math.min(
              stat.birthtimeMs || stat.mtimeMs,
              stat.mtimeMs,
            );
            missingCreated[key] = createdAt;
          }
          const thumbnail = await statOrNull(
            thumbnailFile(workspace, collection, name),
          );
          drawings.push({
            path: toDrawingPath(workspace, collection, name),
            collection,
            name,
            createdAt,
            modifiedAt: stat.mtimeMs,
            size: stat.size,
            pinned: meta.pinned.includes(key),
            thumbnailVersion: thumbnail ? thumbnail.mtimeMs : null,
          });
        }
        collections.push({ name: collection, drawings });
      }

      if (Object.keys(missingCreated).length) {
        // remember creation times before atomic writes replace the files
        await updateMeta(workspace, (meta) => {
          for (const [key, value] of Object.entries(missingCreated)) {
            meta.created[key] ??= value;
          }
        });
      }

      return {
        name: workspace,
        color: meta.color || hashColor(workspace),
        dir: wsDir(workspace),
        collections,
      };
    },

    async createWorkspace(name: string) {
      await ensureRoot();
      if (await exists(wsDir(name))) {
        throw new HttpError(409, `A workspace named "${name}" already exists.`);
      }
      await fs.mkdir(colDir(name, DEFAULT_COLLECTION_NAME), {
        recursive: true,
      });
      return name;
    },

    async renameWorkspace(from: string, to: string) {
      await assertWorkspace(from);
      if (from === to) {
        return to;
      }
      if (
        from.toLowerCase() !== to.toLowerCase() &&
        (await exists(wsDir(to)))
      ) {
        throw new HttpError(409, `A workspace named "${to}" already exists.`);
      }
      await fs.rename(wsDir(from), wsDir(to));
      return to;
    },

    async setWorkspaceColor(workspace: string, color: string) {
      await assertWorkspace(workspace);
      if (!HEX_COLOR_RE.test(color)) {
        throw new HttpError(400, "Invalid color.");
      }
      await updateMeta(workspace, (meta) => {
        meta.color = color;
      });
    },

    async createCollection(workspace: string, name: string) {
      await assertWorkspace(workspace);
      if (await exists(colDir(workspace, name))) {
        throw new HttpError(
          409,
          `A collection named "${name}" already exists.`,
        );
      }
      await fs.mkdir(colDir(workspace, name));
      return name;
    },

    async renameCollection(workspace: string, from: string, to: string) {
      await assertCollection(workspace, from);
      if (from === to) {
        return to;
      }
      if (
        from.toLowerCase() !== to.toLowerCase() &&
        (await exists(colDir(workspace, to)))
      ) {
        throw new HttpError(409, `A collection named "${to}" already exists.`);
      }
      await fs.rename(colDir(workspace, from), colDir(workspace, to));
      await moveIfExists(
        path.join(wsDir(workspace), THUMBNAILS_DIR, from),
        path.join(wsDir(workspace), THUMBNAILS_DIR, to),
      );
      await updateMeta(workspace, (meta) => {
        const prefix = `${from}/`;
        const rename = (key: string) =>
          key.startsWith(prefix) ? `${to}/${key.slice(prefix.length)}` : key;
        meta.pinned = meta.pinned.map(rename);
        meta.created = Object.fromEntries(
          Object.entries(meta.created).map(([key, value]) => [
            rename(key),
            value,
          ]),
        );
      });
      return to;
    },

    async deleteCollection(workspace: string, collection: string) {
      await assertCollection(workspace, collection);
      if ((await listDrawingFiles(colDir(workspace, collection))).length) {
        throw new HttpError(
          409,
          "Only empty collections can be deleted. Move or delete its drawings first.",
        );
      }
      if ((await listDirs(wsDir(workspace))).length <= 1) {
        throw new HttpError(409, "A workspace needs at least one collection.");
      }
      await fs.rm(colDir(workspace, collection), { recursive: true });
      await fs.rm(path.join(wsDir(workspace), THUMBNAILS_DIR, collection), {
        recursive: true,
        force: true,
      });
    },

    read,

    async write(p: string, content: string) {
      const { workspace, collection, name } = validatePath(p);
      await assertCollection(workspace, collection);
      await writeAtomic(drawingFile(workspace, collection, name), content);
    },

    create,

    async rename(p: string, newName: string) {
      const { workspace, collection, name } = validatePath(p);
      if (name === newName) {
        return p;
      }
      await assertDrawing(workspace, collection, name);
      const isCaseOnlyRename = name.toLowerCase() === newName.toLowerCase();
      if (
        !isCaseOnlyRename &&
        (await exists(drawingFile(workspace, collection, newName)))
      ) {
        throw new HttpError(
          409,
          `A drawing named "${newName}" already exists.`,
        );
      }
      await fs.rename(
        drawingFile(workspace, collection, name),
        drawingFile(workspace, collection, newName),
      );
      await moveIfExists(
        thumbnailFile(workspace, collection, name),
        thumbnailFile(workspace, collection, newName),
      );
      await updateMeta(workspace, (meta) =>
        renameMetaKey(
          meta,
          metaKey(collection, name),
          metaKey(collection, newName),
        ),
      );
      return toDrawingPath(workspace, collection, newName);
    },

    async move(p: string, targetCollection: string) {
      const { workspace, collection, name } = validatePath(p);
      if (collection === targetCollection) {
        return p;
      }
      await assertDrawing(workspace, collection, name);
      await assertCollection(workspace, targetCollection);
      const target = await findFreeName(name, (candidate) =>
        exists(drawingFile(workspace, targetCollection, candidate)),
      );
      await fs.rename(
        drawingFile(workspace, collection, name),
        drawingFile(workspace, targetCollection, target),
      );
      await moveIfExists(
        thumbnailFile(workspace, collection, name),
        thumbnailFile(workspace, targetCollection, target),
      );
      await updateMeta(workspace, (meta) =>
        renameMetaKey(
          meta,
          metaKey(collection, name),
          metaKey(targetCollection, target),
        ),
      );
      return toDrawingPath(workspace, targetCollection, target);
    },

    async duplicate(p: string) {
      const { workspace, collection, name } = validatePath(p);
      const newPath = await create(
        workspace,
        collection,
        `${name} (copy)`,
        await read(p),
      );
      const copy = parseDrawingPath(newPath)!;
      try {
        await fs.copyFile(
          thumbnailFile(workspace, collection, name),
          thumbnailFile(workspace, collection, copy.name),
        );
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      return newPath;
    },

    async trash(p: string) {
      const { workspace, collection, name } = validatePath(p);
      await assertDrawing(workspace, collection, name);
      const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
      await fs.mkdir(trashDir(workspace), { recursive: true });
      const info: Omit<TrashItem, "id"> = {
        collection,
        name,
        deletedAt: Date.now(),
      };
      await fs.writeFile(
        path.join(trashDir(workspace), `${id}.json`),
        JSON.stringify(info),
      );
      await fs.rename(
        drawingFile(workspace, collection, name),
        path.join(trashDir(workspace), `${id}${DRAWING_FILE_EXTENSION}`),
      );
      await fs.rm(thumbnailFile(workspace, collection, name), { force: true });
      await updateMeta(workspace, (meta) =>
        removeMetaKey(meta, metaKey(collection, name)),
      );
    },

    listTrash,

    async restore(workspace: string, id: string) {
      const item = (await listTrash(workspace)).find((item) => item.id === id);
      if (!item) {
        throw new HttpError(404, "Not found in the trash.");
      }
      const collection = item.collection;
      await fs.mkdir(colDir(workspace, collection), { recursive: true });
      const name = await findFreeName(item.name, (candidate) =>
        exists(drawingFile(workspace, collection, candidate)),
      );
      await fs.rename(
        path.join(trashDir(workspace), `${id}${DRAWING_FILE_EXTENSION}`),
        drawingFile(workspace, collection, name),
      );
      await fs.rm(path.join(trashDir(workspace), `${id}.json`), {
        force: true,
      });
      return toDrawingPath(workspace, collection, name);
    },

    /** deletes one item for good, or everything when `id` is null */
    async deleteFromTrash(workspace: string, id: string | null) {
      const ids = id
        ? [id]
        : (await listTrash(workspace)).map((item) => item.id);
      for (const itemId of ids) {
        validateName(itemId, "trash id");
        await fs.rm(
          path.join(trashDir(workspace), `${itemId}${DRAWING_FILE_EXTENSION}`),
          { force: true },
        );
        await fs.rm(path.join(trashDir(workspace), `${itemId}.json`), {
          force: true,
        });
      }
    },

    async readThumbnail(p: string) {
      const { workspace, collection, name } = validatePath(p);
      try {
        return await fs.readFile(thumbnailFile(workspace, collection, name));
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, "No thumbnail.");
        }
        throw error;
      }
    },

    async writeThumbnail(p: string, png: Buffer) {
      const { workspace, collection, name } = validatePath(p);
      await assertDrawing(workspace, collection, name);
      if (png.subarray(0, 4).compare(PNG_SIGNATURE) !== 0) {
        throw new HttpError(400, "The thumbnail must be a PNG image.");
      }
      await writeAtomic(thumbnailFile(workspace, collection, name), png);
    },

    async setPinned(p: string, pinned: boolean) {
      const { workspace, collection, name } = validatePath(p);
      await assertDrawing(workspace, collection, name);
      const key = metaKey(collection, name);
      await updateMeta(workspace, (meta) => {
        meta.pinned = meta.pinned.filter((item) => item !== key);
        if (pinned) {
          meta.pinned.push(key);
        }
      });
    },

    /** shows the drawing (or the workspace folder) in Finder/Explorer */
    async reveal(target: { path?: unknown; workspace?: unknown }) {
      let filePath: string;
      if (target.path) {
        const { workspace, collection, name } = validatePath(target.path);
        await assertDrawing(workspace, collection, name);
        filePath = drawingFile(workspace, collection, name);
      } else {
        const workspace = validateName(target.workspace, "workspace name");
        await assertWorkspace(workspace);
        filePath = wsDir(workspace);
      }
      const [command, args]: [string, string[]] =
        process.platform === "darwin"
          ? ["open", ["-R", filePath]]
          : process.platform === "win32"
          ? ["explorer", [`/select,${filePath}`]]
          : ["xdg-open", [path.dirname(filePath)]];
      execFile(command, args, () => {});
    },
  };
};

// -----------------------------------------------------------------------------
// routing
// -----------------------------------------------------------------------------

const createHandler = (root: string) => {
  const store = createStore(root);

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      assertTrustedRequest(req);

      // connect strips the mount path, so `req.url` is relative to the API
      const url = new URL(req.url || "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method || "GET";
      const q = (key: string) => url.searchParams.get(key);
      const ok = (data: unknown = { ok: true }) => sendJson(res, 200, data);
      const workspaceParam = (value: unknown) =>
        validateName(value, "workspace name");
      const collectionParam = (value: unknown) =>
        validateName(value, "collection name");

      switch (`${method} ${route}`) {
        case "GET /":
          return ok(await store.info());

        case "POST /workspaces": {
          const body = await readJsonBody(req);
          return ok({
            name: await store.createWorkspace(workspaceParam(body?.name)),
          });
        }
        case "POST /workspaces/rename": {
          const body = await readJsonBody(req);
          return ok({
            name: await store.renameWorkspace(
              workspaceParam(body?.from),
              workspaceParam(body?.to),
            ),
          });
        }
        case "POST /workspaces/color": {
          const body = await readJsonBody(req);
          await store.setWorkspaceColor(
            workspaceParam(body?.workspace),
            String(body?.color),
          );
          return ok();
        }
        case "GET /workspace":
          return ok(await store.workspace(workspaceParam(q("w"))));

        case "POST /collections": {
          const body = await readJsonBody(req);
          return ok({
            name: await store.createCollection(
              workspaceParam(body?.workspace),
              collectionParam(body?.name),
            ),
          });
        }
        case "POST /collections/rename": {
          const body = await readJsonBody(req);
          return ok({
            name: await store.renameCollection(
              workspaceParam(body?.workspace),
              collectionParam(body?.from),
              collectionParam(body?.to),
            ),
          });
        }
        case "DELETE /collections":
          await store.deleteCollection(
            workspaceParam(q("w")),
            collectionParam(q("c")),
          );
          return ok();

        case "GET /drawing":
          return ok({ content: await store.read(q("p")!) });
        case "PUT /drawing": {
          const body = await readJsonBody(req);
          await store.write(q("p")!, validateContent(body?.content));
          return ok();
        }
        case "POST /drawing": {
          const body = await readJsonBody(req);
          return ok({
            path: await store.create(
              workspaceParam(body?.workspace),
              collectionParam(body?.collection),
              validateName(body?.name),
              validateContent(body?.content),
            ),
          });
        }
        case "DELETE /drawing":
          await store.trash(q("p")!);
          return ok();
        case "POST /drawing/rename": {
          const body = await readJsonBody(req);
          return ok({
            path: await store.rename(body?.path, validateName(body?.name)),
          });
        }
        case "POST /drawing/move": {
          const body = await readJsonBody(req);
          return ok({
            path: await store.move(
              body?.path,
              collectionParam(body?.collection),
            ),
          });
        }
        case "POST /drawing/duplicate": {
          const body = await readJsonBody(req);
          return ok({ path: await store.duplicate(body?.path) });
        }
        case "POST /drawing/pin": {
          const body = await readJsonBody(req);
          await store.setPinned(body?.path, !!body?.pinned);
          return ok();
        }

        case "GET /thumbnail": {
          const png = await store.readThumbnail(q("p")!);
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "no-cache");
          return res.end(png);
        }
        case "PUT /thumbnail":
          await store.writeThumbnail(
            q("p")!,
            await readBody(req, MAX_THUMBNAIL_BYTES),
          );
          return ok();

        case "GET /trash":
          return ok({ items: await store.listTrash(workspaceParam(q("w"))) });
        case "POST /trash/restore": {
          const body = await readJsonBody(req);
          return ok({
            path: await store.restore(
              workspaceParam(body?.workspace),
              validateName(body?.id, "trash id"),
            ),
          });
        }
        case "DELETE /trash":
          await store.deleteFromTrash(
            workspaceParam(q("w")),
            q("id") ? validateName(q("id"), "trash id") : null,
          );
          return ok();

        case "POST /reveal": {
          const body = await readJsonBody(req);
          await store.reveal({ path: body?.path, workspace: body?.workspace });
          return ok();
        }
      }

      throw new HttpError(404, "Unknown endpoint.");
    } catch (error: any) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: error.message });
      }
      console.error("[local-drawings]", error);
      return sendJson(res, 500, {
        error: `File system error: ${error?.message || error}`,
      });
    }
  };
};

export const localDrawingsPlugin = (opts: { dir?: string } = {}): Plugin => {
  const root = resolveDrawingsDir(opts.dir);
  const handler = createHandler(root);

  return {
    name: "excalidraw-local-drawings",
    configureServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, handler);
      server.httpServer?.once("listening", () => {
        server.config.logger.info(`  ➜  Drawings folder: ${root}`);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, handler);
    },
  };
};
