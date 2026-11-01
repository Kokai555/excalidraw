import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAtomValue } from "../../app-jotai";
import {
  createDrawing,
  drawingsRevisionAtom,
  getAllDrawings,
  importDrawings,
  LocalDrawingsAPI,
  localDrawingsErrorAtom,
  openDrawing,
  renameWorkspace,
  rootInfoAtom,
  runLocalAction,
  showLocalToast,
  sidebarStateAtom,
  sortDrawings,
  sortOrderAtom,
  workspaceDataAtom,
} from "../localDrawings";
import { DEFAULT_COLLECTION_NAME } from "../constants";

import {
  DrawingThumbnail,
  formatTimeAgo,
  getDrawingMenuEntries,
  promptName,
  useNow,
} from "./common";
import { openConfirm } from "./Dialogs";
import { Icons } from "./icons";
import { MenuButton } from "./Menu";
import { CollectionIcon, getSortLabel, getSortMenuEntries } from "./Sidebar";

import type { DrawingMeta, TrashItem } from "../constants";

const WORKSPACE_COLORS = [
  "#d63864",
  "#e8590c",
  "#f08c00",
  "#2f9e44",
  "#0c8599",
  "#1971c2",
  "#7048e8",
  "#868e96",
];

const DrawingCard = ({
  drawing,
  api,
  userName,
  now,
  showCollection = false,
}: {
  drawing: DrawingMeta;
  api: ExcalidrawImperativeAPI | null;
  userName: string;
  now: number;
  showCollection?: boolean;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={clsx("ld-card", { "ld-card--menu-open": menuOpen })}>
      <button
        type="button"
        className="ld-card__preview"
        onClick={() =>
          api && runLocalAction(() => openDrawing(api, drawing.path))
        }
        title={`Open ${drawing.name}`}
      >
        <DrawingThumbnail drawing={drawing} className="ld-card__thumbnail" />
        <span className="ld-card__time">
          {formatTimeAgo(drawing.modifiedAt, now)}
        </span>
        {drawing.pinned && <span className="ld-card__pin">{Icons.pin}</span>}
      </button>
      <MenuButton
        className="ld-card__menu-button"
        title="More"
        entries={() => getDrawingMenuEntries(drawing, api)}
        onOpenChange={setMenuOpen}
      >
        {Icons.dots}
      </MenuButton>
      <div className="ld-card__name" title={drawing.name}>
        {drawing.name}
      </div>
      <div className="ld-card__meta">
        by {userName}
        {showCollection && ` · ${drawing.collection}`}
      </div>
    </div>
  );
};

const ActionCards = ({
  api,
  collection,
}: {
  api: ExcalidrawImperativeAPI | null;
  collection: string;
}) => {
  const data = useAtomValue(workspaceDataAtom);
  const target = data ? { workspace: data.name, collection } : null;
  return (
    <div className="ld-action-cards">
      <button
        type="button"
        className="ld-action-card"
        disabled={!api || !target}
        onClick={() =>
          api && target && runLocalAction(() => importDrawings(api, target))
        }
      >
        <span className="ld-action-card__icon">{Icons.importIcon}</span>
        Import scenes
        <span className="ld-action-card__plus">{Icons.plus}</span>
      </button>
      <button
        type="button"
        className="ld-action-card"
        disabled={!api || !target}
        onClick={() =>
          api && target && runLocalAction(() => createDrawing(api, target))
        }
      >
        <span className="ld-action-card__icon">{Icons.filePlus}</span>
        Create scene
        <span className="ld-action-card__plus">{Icons.plus}</span>
      </button>
    </div>
  );
};

const SortButton = () => {
  const sortOrder = useAtomValue(sortOrderAtom);
  return (
    <MenuButton
      className="ld-sort-button"
      title="Sort"
      entries={() => getSortMenuEntries(sortOrder)}
      menuClassName="ld-menu--sort"
    >
      {getSortLabel(sortOrder)}
      {Icons.sort}
    </MenuButton>
  );
};

const CardGrid = ({
  drawings,
  api,
  showCollection,
  emptyText,
}: {
  drawings: DrawingMeta[];
  api: ExcalidrawImperativeAPI | null;
  showCollection?: boolean;
  emptyText: string;
}) => {
  const info = useAtomValue(rootInfoAtom);
  const now = useNow();
  if (!drawings.length) {
    return <div className="ld-page__empty">{emptyText}</div>;
  }
  return (
    <div className="ld-grid">
      {drawings.map((drawing) => (
        <DrawingCard
          key={drawing.path}
          drawing={drawing}
          api={api}
          userName={info?.user.name || ""}
          now={now}
          showCollection={showCollection}
        />
      ))}
    </div>
  );
};

// -----------------------------------------------------------------------------
// pages
// -----------------------------------------------------------------------------

const DashboardPage = ({ api }: { api: ExcalidrawImperativeAPI | null }) => {
  const data = useAtomValue(workspaceDataAtom);
  const sortOrder = useAtomValue(sortOrderAtom);
  const drawings = useMemo(
    () => sortDrawings(getAllDrawings(data), sortOrder),
    [data, sortOrder],
  );
  const pinned = drawings.filter((drawing) => drawing.pinned);
  const others = drawings.filter((drawing) => !drawing.pinned);
  const defaultCollection =
    data?.collections.find((col) => col.name === DEFAULT_COLLECTION_NAME)
      ?.name ||
    data?.collections[0]?.name ||
    DEFAULT_COLLECTION_NAME;

  return (
    <>
      <div className="ld-page__header">
        <div>
          <h1 className="ld-page__title">
            {Icons.dashboard}
            Dashboard
          </h1>
          <p className="ld-page__description">
            All scenes of the {data?.name} workspace.
          </p>
        </div>
        <SortButton />
      </div>
      <ActionCards api={api} collection={defaultCollection} />
      {!!pinned.length && (
        <>
          <h2 className="ld-page__section">Pinned</h2>
          <CardGrid drawings={pinned} api={api} showCollection emptyText="" />
          <h2 className="ld-page__section">All scenes</h2>
        </>
      )}
      <CardGrid
        drawings={others}
        api={api}
        showCollection
        emptyText="No scenes yet. Create or import one to get started."
      />
    </>
  );
};

const CollectionPage = ({
  api,
  name,
}: {
  api: ExcalidrawImperativeAPI | null;
  name: string;
}) => {
  const data = useAtomValue(workspaceDataAtom);
  const sortOrder = useAtomValue(sortOrderAtom);
  const collection = data?.collections.find((col) => col.name === name);
  const drawings = useMemo(
    () => (collection ? sortDrawings(collection.drawings, sortOrder) : []),
    [collection, sortOrder],
  );

  if (data && !collection) {
    return <div className="ld-page__empty">This collection doesn't exist.</div>;
  }

  return (
    <>
      <div className="ld-page__header">
        <div>
          <h1 className="ld-page__title">
            <CollectionIcon name={name} />
            {name}
          </h1>
          <p className="ld-page__description">
            Scenes in this collection are stored in
            <br />
            <code>{data ? `${data.dir}/${name}` : ""}</code>
          </p>
        </div>
        <SortButton />
      </div>
      <ActionCards api={api} collection={name} />
      <CardGrid
        drawings={drawings}
        api={api}
        emptyText="No scenes in this collection yet."
      />
    </>
  );
};

const TrashPage = () => {
  const data = useAtomValue(workspaceDataAtom);
  const revision = useAtomValue(drawingsRevisionAtom);
  const now = useNow();
  const [items, setItems] = useState<TrashItem[] | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }
    let cancelled = false;
    LocalDrawingsAPI.listTrash(data.name)
      .then((items) => !cancelled && setItems(items))
      .catch((error) => showLocalToast(error.message));
    return () => {
      cancelled = true;
    };
  }, [data, revision]);

  return (
    <>
      <div className="ld-page__header">
        <div>
          <h1 className="ld-page__title">
            {Icons.trash}
            Trash
          </h1>
          <p className="ld-page__description">
            Scenes moved to the trash can be restored until you delete them for
            good.
          </p>
        </div>
        {!!items?.length && (
          <button
            type="button"
            className="ld-sort-button ld-sort-button--danger"
            onClick={async () => {
              if (
                data &&
                (await openConfirm({
                  title: "Empty trash",
                  message: `Delete all ${items.length} scenes in the trash for good? This can't be undone.`,
                  confirmLabel: "Empty trash",
                  danger: true,
                }))
              ) {
                runLocalAction(() =>
                  LocalDrawingsAPI.deleteFromTrash(data.name, null),
                );
              }
            }}
          >
            Empty trash
          </button>
        )}
      </div>
      {items && !items.length && (
        <div className="ld-page__empty">The trash is empty.</div>
      )}
      <div className="ld-trash">
        {items?.map((item) => (
          <div key={item.id} className="ld-trash__row">
            <span className="ld-trash__icon">{Icons.file}</span>
            <span className="ld-trash__text">
              <span className="ld-trash__name">{item.name}</span>
              <span className="ld-trash__meta">
                from {item.collection} · deleted{" "}
                {formatTimeAgo(item.deletedAt, now)}
              </span>
            </span>
            <button
              type="button"
              className="ld-button"
              onClick={() =>
                data &&
                runLocalAction(async () => {
                  await LocalDrawingsAPI.restore(data.name, item.id);
                  showLocalToast(`"${item.name}" restored`);
                })
              }
            >
              {Icons.restore}
              Restore
            </button>
            <button
              type="button"
              className="ld-button ld-button--danger-ghost"
              onClick={async () => {
                if (
                  data &&
                  (await openConfirm({
                    title: "Delete for good",
                    message: `Delete "${item.name}" for good? This can't be undone.`,
                    confirmLabel: "Delete",
                    danger: true,
                  }))
                ) {
                  runLocalAction(() =>
                    LocalDrawingsAPI.deleteFromTrash(data.name, item.id),
                  );
                }
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </>
  );
};

const SettingsPage = ({ api }: { api: ExcalidrawImperativeAPI | null }) => {
  const data = useAtomValue(workspaceDataAtom);
  const info = useAtomValue(rootInfoAtom);
  if (!data) {
    return null;
  }
  return (
    <>
      <div className="ld-page__header">
        <div>
          <h1 className="ld-page__title">
            {Icons.settings}
            Settings
          </h1>
          <p className="ld-page__description">
            Settings of the {data.name} workspace.
          </p>
        </div>
      </div>
      <div className="ld-settings">
        <section className="ld-settings__row">
          <div>
            <div className="ld-settings__label">Workspace name</div>
            <div className="ld-settings__value">{data.name}</div>
          </div>
          <button
            type="button"
            className="ld-button"
            onClick={async () => {
              const name = await promptName({
                title: "Rename workspace",
                value: data.name,
                confirmLabel: "Rename",
              });
              if (name && name !== data.name) {
                runLocalAction(() => renameWorkspace(api, data.name, name));
              }
            }}
          >
            {Icons.pencil}
            Rename
          </button>
        </section>
        <section className="ld-settings__row">
          <div>
            <div className="ld-settings__label">Workspace color</div>
            <div className="ld-settings__swatches">
              {WORKSPACE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={clsx("ld-settings__swatch", {
                    "ld-settings__swatch--active": color === data.color,
                  })}
                  style={{ background: color }}
                  aria-label={`Use color ${color}`}
                  onClick={() =>
                    runLocalAction(() =>
                      LocalDrawingsAPI.setWorkspaceColor(data.name, color),
                    )
                  }
                />
              ))}
            </div>
          </div>
        </section>
        <section className="ld-settings__row">
          <div>
            <div className="ld-settings__label">Location</div>
            <div className="ld-settings__value">
              <code>{data.dir}</code>
            </div>
          </div>
          <button
            type="button"
            className="ld-button"
            onClick={() =>
              runLocalAction(() =>
                LocalDrawingsAPI.reveal({ workspace: data.name }),
              )
            }
          >
            {Icons.folder}
            Show in Finder
          </button>
        </section>
        <section className="ld-settings__row">
          <div>
            <div className="ld-settings__label">Author</div>
            <div className="ld-settings__value">
              {info?.user.name}
              {info?.user.email && ` · ${info.user.email}`}
            </div>
            <div className="ld-settings__hint">
              Taken from your git config (user.name / user.email).
            </div>
          </div>
        </section>
      </div>
    </>
  );
};

export const LocalDrawingsBrowsePage = ({
  api,
}: {
  api: ExcalidrawImperativeAPI | null;
}) => {
  const sidebar = useAtomValue(sidebarStateAtom);
  const error = useAtomValue(localDrawingsErrorAtom);
  if (sidebar.mode !== "browse") {
    return null;
  }
  const page = sidebar.page;
  return (
    <div className="ld-page">
      <div className="ld-page__content">
        {error && <div className="ld-banner ld-banner--error">{error}</div>}
        {page.type === "dashboard" && <DashboardPage api={api} />}
        {page.type === "collection" && (
          <CollectionPage key={page.name} api={api} name={page.name} />
        )}
        {page.type === "trash" && <TrashPage />}
        {page.type === "settings" && <SettingsPage api={api} />}
      </div>
    </div>
  );
};
