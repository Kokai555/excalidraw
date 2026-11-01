import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  PlusIcon,
  TrashIcon,
  pencilIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";

import type { Theme } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAtomValue, useSetAtom } from "../app-jotai";

import {
  createDrawing,
  currentDrawingNameAtom,
  deleteDrawing,
  drawingSaveStateAtom,
  drawingsRevisionAtom,
  LocalDrawingsAPI,
  localDrawingsAvailableAtom,
  openDrawing,
  renameDrawing,
  sanitizeDrawingName,
  saveCanvasAsDrawing,
} from "./localDrawings";

import "./DrawingsPanel.scss";

import type { DrawingMeta } from "./constants";
import type { DrawingSaveState } from "./localDrawings";

const COLLAPSED_STORAGE_KEY = "excalidraw-app-drawings-panel-collapsed";
const NARROW_SCREEN_WIDTH = 730;

const panelIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

const refreshIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" strokeLinecap="round" />
    <path d="M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const relativeTimeFormat = new Intl.RelativeTimeFormat("hu", {
  numeric: "auto",
});

const formatModifiedAt = (modifiedAt: number, now: number) => {
  const seconds = Math.round((now - modifiedAt) / 1000);
  if (seconds < 45) {
    return "épp most";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return relativeTimeFormat.format(-minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return relativeTimeFormat.format(-hours, "hour");
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return relativeTimeFormat.format(-days, "day");
  }
  return new Date(modifiedAt).toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const readCollapsed = () => {
  try {
    const stored = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (stored !== null) {
      return stored === "true";
    }
  } catch {
    // ignore
  }
  return window.innerWidth < NARROW_SCREEN_WIDTH;
};

type ListState = {
  loaded: boolean;
  dir: string | null;
  drawings: DrawingMeta[];
  error: string | null;
};

export const DrawingsPanel = ({
  excalidrawAPI,
  theme,
  isCollaborating,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  theme: Theme;
  isCollaborating: boolean;
}) => {
  const currentName = useAtomValue(currentDrawingNameAtom);
  const saveState = useAtomValue(drawingSaveStateAtom);
  const revision = useAtomValue(drawingsRevisionAtom);
  const setAvailable = useSetAtom(localDrawingsAvailableAtom);

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [list, setList] = useState<ListState>({
    loaded: false,
    dir: null,
    drawings: [],
    error: null,
  });
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<{
    name: string;
    draft: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const { dir, drawings } = await LocalDrawingsAPI.list();
      setList({ loaded: true, dir, drawings, error: null });
      setAvailable(true);
    } catch (error: any) {
      setList((prev) => ({ ...prev, loaded: true, error: error.message }));
      setAvailable(false);
    }
  }, [setAvailable]);

  useEffect(() => {
    refresh();
  }, [refresh, revision]);

  useEffect(() => {
    const onFocus = () => {
      refresh();
      setNow(Date.now());
    };
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, String(!prev));
      } catch {
        // ignore
      }
      return !prev;
    });
  };

  const run = async (action: () => Promise<unknown>) => {
    if (!excalidrawAPI || busy) {
      return;
    }
    setBusy(true);
    try {
      await action();
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        excalidrawAPI.setToast({
          message: error?.message || String(error),
          closable: true,
          duration: 6000,
        });
      }
    } finally {
      setBusy(false);
      setNow(Date.now());
      refresh();
    }
  };

  const handleOpen = (name: string) => {
    if (name === currentName || renaming) {
      return;
    }
    run(() => openDrawing(excalidrawAPI!, name));
    if (window.innerWidth < NARROW_SCREEN_WIDTH) {
      setCollapsed(true);
    }
  };

  const handleCreate = () =>
    run(async () => {
      const name = await createDrawing(excalidrawAPI!);
      setSearch("");
      setRenaming({ name, draft: name });
    });

  const handleSaveCanvas = () =>
    run(async () => {
      const name = await saveCanvasAsDrawing(excalidrawAPI!);
      setRenaming({ name, draft: name });
    });

  const commitRename = () => {
    if (!renaming) {
      return;
    }
    const { name, draft } = renaming;
    setRenaming(null);
    const nextName = draft.trim();
    if (!nextName || nextName === name) {
      return;
    }
    if (sanitizeDrawingName(nextName) !== nextName) {
      excalidrawAPI?.setToast({
        message:
          'A név nem kezdődhet ponttal, és nem tartalmazhatja ezeket: \\ / : * ? " < > |',
        closable: true,
        duration: 5000,
      });
      return;
    }
    run(() => renameDrawing(excalidrawAPI!, name, nextName));
  };

  const confirmDelete = () => {
    const name = pendingDelete;
    setPendingDelete(null);
    if (name) {
      run(() => deleteDrawing(excalidrawAPI!, name));
    }
  };

  const filteredDrawings = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("hu");
    return term
      ? list.drawings.filter((drawing) =>
          drawing.name.toLocaleLowerCase("hu").includes(term),
        )
      : list.drawings;
  }, [list.drawings, search]);

  const isAvailable = list.loaded && !list.error;
  const canEdit = isAvailable && !isCollaborating && !!excalidrawAPI;

  const themeClass = theme === "dark" ? "drawings-panel--dark" : null;

  if (collapsed) {
    return (
      <aside
        className={clsx("drawings-panel drawings-panel--collapsed", themeClass)}
      >
        <button
          type="button"
          className="drawings-panel__icon-button"
          onClick={toggleCollapsed}
          title="Rajzok megnyitása"
          aria-label="Rajzok megnyitása"
        >
          {panelIcon}
        </button>
        {canEdit && (
          <button
            type="button"
            className="drawings-panel__icon-button"
            onClick={handleCreate}
            disabled={busy}
            title="Új rajz"
            aria-label="Új rajz"
          >
            {PlusIcon}
          </button>
        )}
      </aside>
    );
  }

  return (
    <aside className={clsx("drawings-panel", themeClass)}>
      <div className="drawings-panel__header">
        <h2 className="drawings-panel__title">Rajzok</h2>
        <div className="drawings-panel__header-buttons">
          <button
            type="button"
            className="drawings-panel__icon-button"
            onClick={() => refresh()}
            title="Lista frissítése"
            aria-label="Lista frissítése"
          >
            {refreshIcon}
          </button>
          <button
            type="button"
            className="drawings-panel__icon-button"
            onClick={toggleCollapsed}
            title="Panel bezárása"
            aria-label="Panel bezárása"
          >
            {panelIcon}
          </button>
        </div>
      </div>

      <button
        type="button"
        className="drawings-panel__new-button"
        onClick={handleCreate}
        disabled={!canEdit || busy}
      >
        {PlusIcon}
        Új rajz
      </button>

      {isCollaborating && (
        <div className="drawings-panel__notice">
          Élő együttműködés közben a fájlmentés szünetel. A munkamenet végén a
          „Mentés fájlként” gombbal mentheted a rajzot.
        </div>
      )}

      {canEdit && !currentName && (
        <div className="drawings-panel__notice">
          A vásznon lévő rajz még nincs fájlba mentve.
          <button
            type="button"
            className="drawings-panel__link-button"
            onClick={handleSaveCanvas}
            disabled={busy}
          >
            Mentés fájlként
          </button>
        </div>
      )}

      {list.error && (
        <div className="drawings-panel__notice drawings-panel__notice--error">
          {list.error}
          <button
            type="button"
            className="drawings-panel__link-button"
            onClick={() => refresh()}
          >
            Újrapróbálás
          </button>
        </div>
      )}

      {isAvailable && list.drawings.length > 0 && (
        <label className="drawings-panel__search">
          {searchIcon}
          <input
            type="search"
            placeholder="Keresés…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      )}

      <ul className="drawings-panel__list">
        {filteredDrawings.map((drawing) => (
          <DrawingItem
            key={drawing.name}
            drawing={drawing}
            now={now}
            isActive={drawing.name === currentName}
            disabled={!canEdit || busy}
            renameDraft={
              renaming?.name === drawing.name ? renaming.draft : null
            }
            onOpen={() => handleOpen(drawing.name)}
            onStartRename={() =>
              setRenaming({ name: drawing.name, draft: drawing.name })
            }
            onRenameDraftChange={(draft) =>
              setRenaming({ name: drawing.name, draft })
            }
            onCommitRename={commitRename}
            onCancelRename={() => setRenaming(null)}
            onDelete={() => setPendingDelete(drawing.name)}
          />
        ))}
        {isAvailable && !list.drawings.length && (
          <li className="drawings-panel__empty">Még nincs rajz a mappában.</li>
        )}
        {isAvailable && !!list.drawings.length && !filteredDrawings.length && (
          <li className="drawings-panel__empty">Nincs találat.</li>
        )}
      </ul>

      <div className="drawings-panel__footer">
        <SaveStatus
          currentName={currentName}
          saveState={saveState}
          isCollaborating={isCollaborating}
        />
        {list.dir && (
          <div className="drawings-panel__dir" title={list.dir}>
            {list.dir.replace(/^\/(Users|home)\/[^/]+/, "~")}
          </div>
        )}
      </div>
      {pendingDelete && (
        <ConfirmDeleteDialog
          name={pendingDelete}
          themeClass={themeClass}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
};

const DrawingItem = ({
  drawing,
  now,
  isActive,
  disabled,
  renameDraft,
  onOpen,
  onStartRename,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  drawing: DrawingMeta;
  now: number;
  isActive: boolean;
  disabled: boolean;
  renameDraft: string | null;
  onOpen: () => void;
  onStartRename: () => void;
  onRenameDraftChange: (draft: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const isRenaming = renameDraft !== null;

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  return (
    <li
      className={clsx("drawings-panel__item", {
        "drawings-panel__item--active": isActive,
      })}
    >
      {isRenaming ? (
        <input
          ref={inputRef}
          className="drawings-panel__rename-input"
          value={renameDraft}
          maxLength={200}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            // keep keystrokes away from the editor's shortcuts
            event.stopPropagation();
            if (event.key === "Enter") {
              onCommitRename();
            } else if (event.key === "Escape") {
              onCancelRename();
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="drawings-panel__item-main"
            onClick={onOpen}
            onDoubleClick={disabled ? undefined : onStartRename}
            disabled={disabled && !isActive}
            title={drawing.name}
          >
            <span className="drawings-panel__item-name">{drawing.name}</span>
            <span className="drawings-panel__item-meta">
              {formatModifiedAt(drawing.modifiedAt, now)}
            </span>
          </button>
          {!disabled && (
            <div className="drawings-panel__item-actions">
              <button
                type="button"
                className="drawings-panel__icon-button"
                onClick={onStartRename}
                title="Átnevezés"
                aria-label={`${drawing.name} átnevezése`}
              >
                {pencilIcon}
              </button>
              <button
                type="button"
                className="drawings-panel__icon-button drawings-panel__icon-button--danger"
                onClick={onDelete}
                title="Törlés"
                aria-label={`${drawing.name} törlése`}
              >
                {TrashIcon}
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
};

const SaveStatus = ({
  currentName,
  saveState,
  isCollaborating,
}: {
  currentName: string | null;
  saveState: DrawingSaveState;
  isCollaborating: boolean;
}) => {
  if (isCollaborating || !currentName) {
    return <div className="drawings-panel__status">Nincs fájlhoz rendelve</div>;
  }
  if (saveState.status === "error") {
    return (
      <div
        className="drawings-panel__status drawings-panel__status--error"
        title={saveState.error}
      >
        Mentési hiba: {saveState.error}
      </div>
    );
  }
  return (
    <div className="drawings-panel__status">
      {saveState.status === "saving" ? "Mentés…" : "Minden változás mentve"}
    </div>
  );
};

const ConfirmDeleteDialog = ({
  name,
  themeClass,
  onConfirm,
  onCancel,
}: {
  name: string;
  themeClass: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) =>
  createPortal(
    <div
      className={clsx("drawings-panel-modal", themeClass)}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        // keep keystrokes away from the editor's shortcuts
        event.stopPropagation();
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <div
        className="drawings-panel-modal__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="drawings-panel-modal-title"
      >
        <h3 id="drawings-panel-modal-title">Rajz törlése</h3>
        <p>
          Biztosan törlöd: <strong>„{name}”</strong>?
        </p>
        <p className="drawings-panel-modal__hint">
          A fájl a rajzok mappáján belüli <code>.trash</code> mappába kerül,
          onnan visszaállítható.
        </p>
        <div className="drawings-panel-modal__actions">
          <button type="button" onClick={onCancel}>
            Mégse
          </button>
          <button
            type="button"
            className="drawings-panel-modal__danger"
            onClick={onConfirm}
            autoFocus
          >
            Törlés
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
