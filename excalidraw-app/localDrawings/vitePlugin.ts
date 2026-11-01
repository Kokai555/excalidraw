/// <reference types="node" />

/**
 * Vite plugin that exposes a tiny REST API for storing drawings as
 * `.excalidraw` files in a folder on the local disk.
 *
 * Mounted on both the dev server (`yarn start`) and the preview server.
 * Only requests coming from the app itself (same origin, localhost) are
 * accepted, so other websites open in the browser can't read or write
 * the drawings.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DRAWING_FILE_EXTENSION,
  LOCAL_DRAWINGS_API_PATH,
  MAX_DRAWING_NAME_LENGTH,
} from "./constants";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

import type { DrawingMeta, DrawingsListResponse } from "./constants";

const TRASH_DIR_NAME = ".trash";
const MAX_BODY_BYTES = 200 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const resolveDrawingsDir = (dir?: string) => {
  if (!dir) {
    return path.join(os.homedir(), "Documents", "Excalidraw");
  }
  if (dir === "~" || dir.startsWith("~/")) {
    return path.join(os.homedir(), dir.slice(1));
  }
  return path.resolve(dir);
};

const validateName = (raw: unknown): string => {
  if (typeof raw !== "string") {
    throw new HttpError(400, "Hiányzó fájlnév.");
  }
  const name = raw.normalize("NFC").trim();
  if (!name) {
    throw new HttpError(400, "A fájlnév nem lehet üres.");
  }
  if (name.length > MAX_DRAWING_NAME_LENGTH) {
    throw new HttpError(400, "A fájlnév túl hosszú.");
  }
  if (name.startsWith(".") || INVALID_NAME_CHARS.test(name)) {
    throw new HttpError(
      400,
      'A fájlnév nem kezdődhet ponttal, és nem tartalmazhatja ezeket: \\ / : * ? " < > |',
    );
  }
  return name;
};

const validateContent = (content: unknown): string => {
  if (typeof content !== "string") {
    throw new HttpError(400, "Hiányzó tartalom.");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new HttpError(400, "A tartalom nem érvényes JSON.");
  }
  if (parsed?.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
    throw new HttpError(400, "A tartalom nem Excalidraw rajz.");
  }
  return content;
};

const isNotFound = (error: any) => error?.code === "ENOENT";

const fileExists = async (filePath: string) => {
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

/**
 * Only accept requests the app itself makes: the server must be reached via
 * localhost (guards against DNS rebinding) and the request must not come from
 * another origin (guards against other websites calling the API).
 */
const assertTrustedRequest = (req: IncomingMessage) => {
  const host = req.headers.host || "";
  if (!LOCAL_HOST_RE.test(host)) {
    throw new HttpError(403, "Csak localhostról érhető el.");
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
      throw new HttpError(403, "Idegen eredetű kérés.");
    }
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "Idegen eredetű kérés.");
  }
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "A rajz túl nagy."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const readJsonBody = async (req: IncomingMessage): Promise<any> => {
  const body = await readBody(req);
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Érvénytelen kérés.");
  }
};

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
};

const createDrawingsStore = (dir: string) => {
  const filePathFor = (name: string) => {
    const filePath = path.join(dir, `${name}${DRAWING_FILE_EXTENSION}`);
    // defense in depth: the name is validated, but never leave the folder
    if (path.dirname(filePath) !== dir) {
      throw new HttpError(400, "Érvénytelen fájlnév.");
    }
    return filePath;
  };

  /** write to a temp file and rename, so a crash never leaves half a file */
  const writeAtomic = async (filePath: string, content: string) => {
    const tmpPath = path.join(
      dir,
      `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      throw error;
    }
  };

  return {
    async list(): Promise<DrawingsListResponse> {
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const drawings: DrawingMeta[] = [];
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          entry.name.startsWith(".") ||
          !entry.name.endsWith(DRAWING_FILE_EXTENSION)
        ) {
          continue;
        }
        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          drawings.push({
            name: entry.name
              .slice(0, -DRAWING_FILE_EXTENSION.length)
              .normalize("NFC"),
            modifiedAt: stat.mtimeMs,
            size: stat.size,
          });
        } catch (error) {
          // deleted in the meantime
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }
      drawings.sort((a, b) => b.modifiedAt - a.modifiedAt);
      return { dir, drawings };
    },

    async read(name: string) {
      try {
        return await fs.readFile(filePathFor(name), "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          throw new HttpError(404, `A(z) „${name}” rajz nem található.`);
        }
        throw error;
      }
    },

    async write(name: string, content: string) {
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(filePathFor(name), content);
    },

    /** creates a new file, picking a free name ("Name 2", "Name 3", …) */
    async create(baseName: string, content: string) {
      await fs.mkdir(dir, { recursive: true });
      for (let i = 1; i < 1000; i++) {
        const suffix = i === 1 ? "" : ` ${i}`;
        const name = `${baseName.slice(
          0,
          MAX_DRAWING_NAME_LENGTH - suffix.length,
        )}${suffix}`;
        try {
          // "wx" fails if the file exists, so we never overwrite anything
          await fs.writeFile(filePathFor(name), content, {
            encoding: "utf8",
            flag: "wx",
          });
          return name;
        } catch (error: any) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
        }
      }
      throw new HttpError(409, "Nem sikerült szabad fájlnevet találni.");
    },

    async rename(from: string, to: string) {
      const fromPath = filePathFor(from);
      const toPath = filePathFor(to);
      if (fromPath === toPath) {
        return;
      }
      if (!(await fileExists(fromPath))) {
        throw new HttpError(404, `A(z) „${from}” rajz nem található.`);
      }
      // on case-insensitive file systems (macOS) a case-only rename targets
      // the same file, which is fine
      const isCaseOnlyRename = from.toLowerCase() === to.toLowerCase();
      if (!isCaseOnlyRename && (await fileExists(toPath))) {
        throw new HttpError(409, `Már létezik „${to}” nevű rajz.`);
      }
      await fs.rename(fromPath, toPath);
    },

    /** moves the file into `<dir>/.trash` instead of deleting it for good */
    async trash(name: string) {
      const filePath = filePathFor(name);
      if (!(await fileExists(filePath))) {
        throw new HttpError(404, `A(z) „${name}” rajz nem található.`);
      }
      const trashDir = path.join(dir, TRASH_DIR_NAME);
      await fs.mkdir(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.rename(
        filePath,
        path.join(trashDir, `${name} (${stamp})${DRAWING_FILE_EXTENSION}`),
      );
    },
  };
};

const createHandler = (dir: string) => {
  const store = createDrawingsStore(dir);

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      assertTrustedRequest(req);

      // connect strips the mount path, so `req.url` is relative to the API
      const url = new URL(req.url || "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method || "GET";

      if (route === "/" && method === "GET") {
        return sendJson(res, 200, await store.list());
      }

      if (route === "/drawing") {
        if (method === "GET") {
          const name = validateName(url.searchParams.get("name"));
          return sendJson(res, 200, { name, content: await store.read(name) });
        }
        if (method === "PUT") {
          const name = validateName(url.searchParams.get("name"));
          const body = await readJsonBody(req);
          await store.write(name, validateContent(body?.content));
          return sendJson(res, 200, { name });
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          const name = await store.create(
            validateName(body?.name),
            validateContent(body?.content),
          );
          return sendJson(res, 201, { name });
        }
        if (method === "DELETE") {
          const name = validateName(url.searchParams.get("name"));
          await store.trash(name);
          return sendJson(res, 200, { name });
        }
      }

      if (route === "/rename" && method === "POST") {
        const body = await readJsonBody(req);
        const from = validateName(body?.from);
        const to = validateName(body?.to);
        await store.rename(from, to);
        return sendJson(res, 200, { name: to });
      }

      throw new HttpError(404, "Ismeretlen végpont.");
    } catch (error: any) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: error.message });
      }
      console.error("[local-drawings]", error);
      return sendJson(res, 500, {
        error: `Fájlrendszer hiba: ${error?.message || error}`,
      });
    }
  };
};

export const localDrawingsPlugin = (opts: { dir?: string } = {}): Plugin => {
  const dir = resolveDrawingsDir(opts.dir);
  const handler = createHandler(dir);

  return {
    name: "excalidraw-local-drawings",
    configureServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, handler);
      server.httpServer?.once("listening", () => {
        server.config.logger.info(`  ➜  Rajzok mappája: ${dir}`);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, handler);
    },
  };
};
