import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom, useAtom, useAtomValue } from "../../app-jotai";
import {
  getAllDrawings,
  localToastAtom,
  openDrawing,
  runLocalAction,
  sortDrawings,
  workspaceDataAtom,
} from "../localDrawings";

import { DrawingThumbnail, formatTimeAgo, useNow } from "./common";
import { Icons } from "./icons";

import type { ReactNode } from "react";

// -----------------------------------------------------------------------------
// prompt & confirm
// -----------------------------------------------------------------------------

type DialogState =
  | {
      kind: "prompt";
      title: string;
      value: string;
      confirmLabel: string;
      validate?: (value: string) => string | null;
      resolve: (value: string | null) => void;
    }
  | {
      kind: "confirm";
      title: string;
      message: ReactNode;
      confirmLabel: string;
      danger?: boolean;
      resolve: (value: boolean) => void;
    };

const dialogAtom = atom<DialogState | null>(null);

export const openPrompt = (opts: {
  title: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
}) =>
  new Promise<string | null>((resolve) =>
    appJotaiStore.set(dialogAtom, { kind: "prompt", ...opts, resolve }),
  );

export const openConfirm = (opts: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}) =>
  new Promise<boolean>((resolve) =>
    appJotaiStore.set(dialogAtom, { kind: "confirm", ...opts, resolve }),
  );

export const quickSearchOpenAtom = atom(false);

/** keeps keystrokes inside our dialogs away from the editor's shortcuts */
const stopKeys = (event: React.KeyboardEvent) => event.stopPropagation();

const Modal = ({
  children,
  onClose,
  className,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) =>
  createPortal(
    <div
      className="ld-modal-backdrop"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        stopKeys(event);
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <div className={clsx("ld-modal", className)} role="dialog" aria-modal>
        <button
          type="button"
          className="ld-modal__close"
          onClick={onClose}
          aria-label="Close"
        >
          {Icons.close}
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );

const PromptDialog = ({
  dialog,
  onDone,
}: {
  dialog: Extract<DialogState, { kind: "prompt" }>;
  onDone: () => void;
}) => {
  const [value, setValue] = useState(dialog.value);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const close = (result: string | null) => {
    dialog.resolve(result);
    onDone();
  };

  const submit = () => {
    const message = dialog.validate?.(value) ?? null;
    if (message) {
      setError(message);
      return;
    }
    close(value);
  };

  return (
    <Modal onClose={() => close(null)} className="ld-modal--small">
      <h2 className="ld-modal__title">{dialog.title}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          className={clsx("ld-input", { "ld-input--error": error })}
          value={value}
          maxLength={200}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
        {error && <div className="ld-modal__error">{error}</div>}
        <div className="ld-modal__actions">
          <button
            type="button"
            className="ld-button"
            onClick={() => close(null)}
          >
            Cancel
          </button>
          <button type="submit" className="ld-button ld-button--primary">
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const ConfirmDialog = ({
  dialog,
  onDone,
}: {
  dialog: Extract<DialogState, { kind: "confirm" }>;
  onDone: () => void;
}) => {
  const close = (result: boolean) => {
    dialog.resolve(result);
    onDone();
  };
  return (
    <Modal onClose={() => close(false)} className="ld-modal--small">
      <h2 className="ld-modal__title">{dialog.title}</h2>
      <div className="ld-modal__message">{dialog.message}</div>
      <div className="ld-modal__actions">
        <button
          type="button"
          className="ld-button"
          onClick={() => close(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={clsx("ld-button", {
            "ld-button--danger": dialog.danger,
            "ld-button--primary": !dialog.danger,
          })}
          onClick={() => close(true)}
          autoFocus
        >
          {dialog.confirmLabel}
        </button>
      </div>
    </Modal>
  );
};

// -----------------------------------------------------------------------------
// quick search
// -----------------------------------------------------------------------------

const normalize = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const QuickSearch = ({
  api,
  onClose,
}: {
  api: ExcalidrawImperativeAPI | null;
  onClose: () => void;
}) => {
  const data = useAtomValue(workspaceDataAtom);
  const now = useNow();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const drawings = sortDrawings(getAllDrawings(data), "updated");
    const term = normalize(query.trim());
    if (!term) {
      return [];
    }
    return drawings.filter((drawing) =>
      normalize(`${drawing.name} ${drawing.collection}`).includes(term),
    );
  }, [data, query]);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".ld-search__result--selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (index: number) => {
    const drawing = results[index];
    if (drawing && api) {
      onClose();
      runLocalAction(() => openDrawing(api, drawing.path));
    }
  };

  return (
    <Modal onClose={onClose} className="ld-search">
      <input
        ref={inputRef}
        className="ld-search__input"
        placeholder={`Search in ${data?.name ?? "workspace"}...`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((index) => Math.min(index + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            open(selected);
          }
        }}
      />
      <div className="ld-search__hints">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Select
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </div>
      <div className="ld-search__results" ref={listRef}>
        {results.length ? (
          results.map((drawing, index) => (
            <button
              key={drawing.path}
              type="button"
              className={clsx("ld-search__result", {
                "ld-search__result--selected": index === selected,
              })}
              onPointerMove={() => setSelected(index)}
              onClick={() => open(index)}
            >
              <DrawingThumbnail
                drawing={drawing}
                className="ld-search__thumbnail"
              />
              <span className="ld-search__result-text">
                <span className="ld-search__result-name">{drawing.name}</span>
                <span className="ld-search__result-meta">
                  {drawing.collection} ·{" "}
                  {formatTimeAgo(drawing.modifiedAt, now)}
                </span>
              </span>
            </button>
          ))
        ) : (
          <div className="ld-search__empty">
            {Icons.search}
            Nothing here...
          </div>
        )}
      </div>
    </Modal>
  );
};

// -----------------------------------------------------------------------------
// host
// -----------------------------------------------------------------------------

export const LocalDrawingsDialogs = ({
  api,
}: {
  api: ExcalidrawImperativeAPI | null;
}) => {
  const [dialog, setDialog] = useAtom(dialogAtom);
  const [quickSearchOpen, setQuickSearchOpen] = useAtom(quickSearchOpenAtom);
  const toast = useAtomValue(localToastAtom);
  const done = () => setDialog(null);

  return (
    <>
      {dialog?.kind === "prompt" && (
        <PromptDialog key={dialog.title} dialog={dialog} onDone={done} />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog dialog={dialog} onDone={done} />
      )}
      {quickSearchOpen && (
        <QuickSearch api={api} onClose={() => setQuickSearchOpen(false)} />
      )}
      {toast &&
        createPortal(
          <div className="ld-toast" key={toast.id} role="status">
            {toast.message}
          </div>,
          document.body,
        )}
    </>
  );
};
