/// <reference types="node" />

/**
 * Mounts the local drawings API (see `server.ts`) on the Vite dev server
 * (`yarn start`) and the preview server.
 *
 * Only requests coming from the app itself (same origin, localhost) are
 * accepted, so other websites open in the browser can't read or write
 * the drawings.
 */

import { LOCAL_DRAWINGS_API_PATH } from "./constants";
import {
  createLocalDrawingsHandler,
  HttpError,
  resolveDrawingsDir,
  tooLargeError,
} from "./server";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

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
        reject(tooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const localDrawingsPlugin = (opts: { dir?: string } = {}): Plugin => {
  const root = resolveDrawingsDir(opts.dir);
  const handle = createLocalDrawingsHandler(root);

  const middleware = async (req: IncomingMessage, res: ServerResponse) => {
    let response;
    try {
      assertTrustedRequest(req);
      response = await handle({
        method: req.method || "GET",
        // connect strips the mount path, so `req.url` is relative to the API
        url: req.url || "/",
        readBody: (limit) => readBody(req, limit),
      });
    } catch (error: any) {
      response = {
        status: error instanceof HttpError ? error.status : 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: error?.message || String(error) }),
      };
    }
    res.statusCode = response.status;
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.end(response.body);
  };

  return {
    name: "excalidraw-local-drawings",
    configureServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, middleware);
      server.httpServer?.once("listening", () => {
        server.config.logger.info(`  ➜  Drawings folder: ${root}`);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(LOCAL_DRAWINGS_API_PATH, middleware);
    },
  };
};
