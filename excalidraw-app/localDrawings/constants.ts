// shared between the Vite plugin (Node) and the app (browser), so keep this
// file free of imports

export const LOCAL_DRAWINGS_API_PATH = "/api/local-drawings";
export const DRAWING_FILE_EXTENSION = ".excalidraw";
export const MAX_DRAWING_NAME_LENGTH = 200;

export type DrawingMeta = {
  /** file name without the `.excalidraw` extension */
  name: string;
  /** last modification time (ms since epoch) */
  modifiedAt: number;
  /** file size in bytes */
  size: number;
};

export type DrawingsListResponse = {
  /** absolute path of the folder on disk */
  dir: string;
  drawings: DrawingMeta[];
};
