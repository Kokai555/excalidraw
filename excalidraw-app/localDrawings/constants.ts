// shared between the Vite plugin (Node) and the app (browser), so keep this
// file free of imports

export const LOCAL_DRAWINGS_API_PATH = "/api/local-drawings";
export const DRAWING_FILE_EXTENSION = ".excalidraw";
export const MAX_NAME_LENGTH = 200;
export const DEFAULT_WORKSPACE_NAME = "My workspace";
export const DEFAULT_COLLECTION_NAME = "Private";

/**
 * On disk: `<root>/<workspace>/<collection>/<name>.excalidraw`.
 * A drawing is identified by its path `"<workspace>/<collection>/<name>"`.
 */
export type DrawingPath = string;

export const toDrawingPath = (
  workspace: string,
  collection: string,
  name: string,
): DrawingPath => `${workspace}/${collection}/${name}`;

export const parseDrawingPath = (path: DrawingPath) => {
  const parts = path.split("/");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return null;
  }
  const [workspace, collection, name] = parts;
  return { workspace, collection, name };
};

export type LocalUser = { name: string; email: string | null };

export type WorkspaceInfo = { name: string; color: string };

export type RootInfo = {
  /** absolute path of the drawings root folder */
  root: string;
  user: LocalUser;
  workspaces: WorkspaceInfo[];
};

export type DrawingMeta = {
  path: DrawingPath;
  collection: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  size: number;
  pinned: boolean;
  /** mtime of the thumbnail, null if there's none yet */
  thumbnailVersion: number | null;
};

export type CollectionInfo = { name: string; drawings: DrawingMeta[] };

export type WorkspaceData = {
  name: string;
  color: string;
  /** absolute path of the workspace folder */
  dir: string;
  collections: CollectionInfo[];
};

export type TrashItem = {
  id: string;
  collection: string;
  name: string;
  deletedAt: number;
};
