# Excalidraw desktop (macOS)

An Electron wrapper around `excalidraw-app` with the local drawings sidebar. Drawings are stored as `.excalidraw` files in `~/Documents/Excalidraw`, the same folder the dev server (`yarn start`) uses.

## Build

Requires the repo's dependencies (`yarn` in the repo root) and Node 22.12+.

```bash
cd excalidraw-desktop
yarn            # installs Electron & electron-builder
yarn dist       # builds the web app + main process, then packages the app
```

The result is in `release/`:

- `Excalidraw-<version>-arm64.dmg`: open it and drag Excalidraw into Applications
- `mac-arm64/Excalidraw.app`: the app itself

The app is ad-hoc signed, not notarized. Builds made on your own Mac open normally; a copy downloaded from elsewhere has to be opened once with right click → Open.

## Development

```bash
yarn build:web  # only needed after changes to excalidraw-app
yarn start      # bundles src/main.ts and starts Electron
```

`EXCALIDRAW_DRAWINGS_DIR=/some/folder yarn start` uses another drawings folder.

If `yarn start` fails with `Cannot read properties of undefined` in `dist/main.js`, the `ELECTRON_RUN_AS_NODE` environment variable is set (e.g. in terminals of Electron based editors); unset it first.

## How it works

- `src/main.ts` serves the web build (`web/`) and the local drawings API (`excalidraw-app/localDrawings/server.ts`) from the privileged `app://excalidraw` protocol, so nothing listens on a network port and the app's storage (localStorage, IndexedDB) keeps a stable origin.
- The web app is built with `VITE_APP_DESKTOP=true`, which skips the service worker and analytics and exposes a small bridge (`excalidraw-app/localDrawings/desktop.ts`) used by the main process to:
  - save the open drawing before the window closes or reloads,
  - open `.excalidraw` files from Finder: drawings inside the drawings folder open in place, other files are imported as new drawings.
- Links open in the default browser; the window size & position are remembered.
