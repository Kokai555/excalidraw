import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAtomValue, useSetAtom } from "../../app-jotai";
import {
  activeWorkspaceAtom,
  createCollection,
  createDrawing,
  createWorkspace,
  currentDrawingPathAtom,
  deleteCollection,
  drawingsRevisionAtom,
  LocalDrawingsAPI,
  localDrawingsErrorAtom,
  openDrawing,
  refreshLocalDrawings,
  renameCollection,
  rootInfoAtom,
  runLocalAction,
  saveCanvasAsDrawing,
  setActiveWorkspace,
  setSidebarState,
  setSortOrder,
  sidebarStateAtom,
  sortDrawings,
  sortOrderAtom,
  workspaceDataAtom,
} from "../localDrawings";
import { DEFAULT_COLLECTION_NAME } from "../constants";

import {
  Avatar,
  DrawingThumbnail,
  USER_AVATAR_COLOR,
  formatTimeAgo,
  getDrawingMenuEntries,
  promptName,
  useNow,
} from "./common";
import { openConfirm, quickSearchOpenAtom } from "./Dialogs";
import { Icons } from "./icons";
import "./LocalDrawings.scss";
import { Menu, MenuButton } from "./Menu";

import type { DrawingMeta } from "../constants";
import type { SortOrder } from "../localDrawings";
import type { MenuEntry } from "./Menu";

const SORT_LABELS: Record<SortOrder, string> = {
  name: "Name",
  created: "Last created",
  updated: "Last updated",
};

export const getSortMenuEntries = (current: SortOrder): MenuEntry[] =>
  (Object.keys(SORT_LABELS) as SortOrder[]).map((order) => ({
    label: SORT_LABELS[order],
    checked: order === current,
    onSelect: () => setSortOrder(order),
  }));

export const getSortLabel = (order: SortOrder) => SORT_LABELS[order];

export const CollectionIcon = ({ name }: { name: string }) =>
  name === DEFAULT_COLLECTION_NAME ? Icons.lock : Icons.collection;

// -----------------------------------------------------------------------------
// header: workspace switcher
// -----------------------------------------------------------------------------

const WorkspaceHeader = () => {
  const info = useAtomValue(rootInfoAtom);
  const data = useAtomValue(workspaceDataAtom);
  const activeWorkspace = useAtomValue(activeWorkspaceAtom);
  const headerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const workspace =
    info?.workspaces.find((ws) => ws.name === activeWorkspace) ||
    (data ? { name: data.name, color: data.color } : null);

  const entries: MenuEntry[] = [
    { type: "label", label: "You manage" },
    ...(info?.workspaces || []).map(
      (ws): MenuEntry => ({
        label: ws.name,
        icon: <Avatar name={ws.name} color={ws.color} />,
        active: ws.name === activeWorkspace,
        className: "ld-workspace-menu__item",
        onSelect: () => {
          setActiveWorkspace(ws.name);
          setSidebarState({ mode: "browse", page: { type: "dashboard" } });
        },
      }),
    ),
    { type: "separator" },
    {
      label: "Create workspace",
      icon: <span className="ld-dashed-plus">{Icons.plus}</span>,
      className: "ld-workspace-menu__create",
      onSelect: async () => {
        const name = await promptName({
          title: "Create workspace",
          value: "",
          confirmLabel: "Create",
        });
        if (name) {
          runLocalAction(() => createWorkspace(name));
        }
      },
    },
    {
      type: "custom",
      content: (
        <div className="ld-workspace-menu__account">
          <Avatar
            name={info?.user.name || "?"}
            color={USER_AVATAR_COLOR}
            className="ld-avatar--tiny"
          />
          <span>{info?.user.email || info?.user.name}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="ld-sidebar__header" ref={headerRef}>
      {workspace ? (
        <>
          <Avatar
            name={workspace.name}
            color={workspace.color}
            className="ld-avatar--large"
          />
          <span className="ld-sidebar__workspace-name" title={workspace.name}>
            {workspace.name}
          </span>
        </>
      ) : (
        <span className="ld-sidebar__workspace-name" />
      )}
      <button
        type="button"
        className={clsx("ld-icon-button ld-sidebar__switcher", {
          "is-open": open,
        })}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Switch workspace"
        title="Switch workspace"
      >
        {Icons.chevronsUpDown}
      </button>
      {open && headerRef.current && (
        <Menu
          anchor={headerRef.current}
          entries={entries}
          onClose={() => setOpen(false)}
          placement="bottom-start"
          className="ld-workspace-menu"
          width={headerRef.current.offsetWidth + 4}
        />
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// editor mode: drawings of one collection
// -----------------------------------------------------------------------------

const DrawingListItem = ({
  drawing,
  isActive,
  api,
  userName,
  now,
}: {
  drawing: DrawingMeta;
  isActive: boolean;
  api: ExcalidrawImperativeAPI | null;
  userName: string;
  now: number;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={clsx("ld-item", {
        "ld-item--active": isActive,
        "ld-item--menu-open": menuOpen,
      })}
      role="button"
      tabIndex={0}
      onClick={() =>
        api && runLocalAction(() => openDrawing(api, drawing.path))
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" && api) {
          runLocalAction(() => openDrawing(api, drawing.path));
        }
      }}
      title={drawing.name}
    >
      <DrawingThumbnail drawing={drawing} className="ld-item__thumbnail">
        <Avatar
          name={userName}
          color={USER_AVATAR_COLOR}
          className="ld-avatar--badge"
        />
      </DrawingThumbnail>
      <span className="ld-item__text">
        <span className="ld-item__name">
          {drawing.name}
          {drawing.pinned && <span className="ld-item__pin">{Icons.pin}</span>}
        </span>
        <span className="ld-item__meta">by {userName}</span>
        <span className="ld-item__meta">
          {formatTimeAgo(drawing.modifiedAt, now)}
        </span>
      </span>
      <MenuButton
        className="ld-item__menu-button"
        title="More"
        entries={() => getDrawingMenuEntries(drawing, api)}
        onOpenChange={setMenuOpen}
      >
        {Icons.dots}
      </MenuButton>
    </div>
  );
};

const CollectionView = ({
  api,
  isCollaborating,
}: {
  api: ExcalidrawImperativeAPI | null;
  isCollaborating: boolean;
}) => {
  const data = useAtomValue(workspaceDataAtom);
  const info = useAtomValue(rootInfoAtom);
  const sidebar = useAtomValue(sidebarStateAtom);
  const sortOrder = useAtomValue(sortOrderAtom);
  const currentPath = useAtomValue(currentDrawingPathAtom);
  const error = useAtomValue(localDrawingsErrorAtom);
  const now = useNow();

  const collection =
    data?.collections.find((col) => col.name === sidebar.collection) ||
    data?.collections.find((col) => col.name === DEFAULT_COLLECTION_NAME) ||
    data?.collections[0];

  const drawings = useMemo(
    () => (collection ? sortDrawings(collection.drawings, sortOrder) : []),
    [collection, sortOrder],
  );

  const target =
    data && collection
      ? { workspace: data.name, collection: collection.name }
      : null;

  return (
    <>
      <div className="ld-collection-header">
        <button
          type="button"
          className="ld-icon-button ld-collection-header__back"
          onClick={() =>
            collection &&
            setSidebarState({
              mode: "browse",
              page: { type: "collection", name: collection.name },
            })
          }
          aria-label="Back to the collection"
          title="Back to the collection"
        >
          {Icons.chevronLeft}
        </button>
        {collection && (
          <>
            <span className="ld-collection-header__icon">
              <CollectionIcon name={collection.name} />
            </span>
            <span
              className="ld-collection-header__name"
              title={collection.name}
            >
              {collection.name}
            </span>
          </>
        )}
        <MenuButton
          className="ld-icon-button ld-collection-header__sort"
          title="Sort"
          entries={() => getSortMenuEntries(sortOrder)}
          menuClassName="ld-menu--sort"
        >
          {Icons.sort}
        </MenuButton>
        <button
          type="button"
          className="ld-plus-button"
          disabled={!target || !api || isCollaborating}
          onClick={() =>
            api && target && runLocalAction(() => createDrawing(api, target))
          }
          aria-label="Create scene"
          title="Create scene"
        >
          {Icons.plus}
        </button>
      </div>

      {error && <div className="ld-banner ld-banner--error">{error}</div>}
      {isCollaborating && (
        <div className="ld-banner">
          Saving to the file is paused during live collaboration.
        </div>
      )}
      {!isCollaborating && !error && !currentPath && target && (
        <div className="ld-banner">
          This canvas isn't saved to a file yet.
          <button
            type="button"
            className="ld-banner__action"
            onClick={() =>
              api && runLocalAction(() => saveCanvasAsDrawing(api, target))
            }
          >
            Save to {target.collection}
          </button>
        </div>
      )}

      <div className="ld-list">
        {drawings.map((drawing) => (
          <DrawingListItem
            key={drawing.path}
            drawing={drawing}
            isActive={drawing.path === currentPath}
            api={api}
            userName={info?.user.name || ""}
            now={now}
          />
        ))}
        {collection && !drawings.length && (
          <div className="ld-list__empty">
            No scenes in this collection yet.
          </div>
        )}
      </div>
    </>
  );
};

// -----------------------------------------------------------------------------
// browse mode: navigation & collections
// -----------------------------------------------------------------------------

const NavItem = ({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={clsx("ld-nav-item", { "ld-nav-item--active": active })}
    onClick={onClick}
  >
    <span className="ld-nav-item__icon">{icon}</span>
    {label}
  </button>
);

const NavView = ({ api }: { api: ExcalidrawImperativeAPI | null }) => {
  const data = useAtomValue(workspaceDataAtom);
  const sidebar = useAtomValue(sidebarStateAtom);
  const page = sidebar.page;

  const collectionMenu = (name: string): MenuEntry[] => [
    {
      label: "Rename",
      icon: Icons.pencil,
      onSelect: async () => {
        const newName = await promptName({
          title: "Rename collection",
          value: name,
          confirmLabel: "Rename",
        });
        if (data && newName && newName !== name) {
          runLocalAction(() => renameCollection(api, data.name, name, newName));
        }
      },
    },
    {
      label: "Show in Finder",
      icon: Icons.folder,
      onSelect: () =>
        data &&
        runLocalAction(async () => {
          const drawing = data.collections.find((col) => col.name === name)
            ?.drawings[0];
          await LocalDrawingsAPI.reveal(
            drawing ? { path: drawing.path } : { workspace: data.name },
          );
        }),
    },
    { type: "separator" },
    {
      label: "Delete collection",
      icon: Icons.trash,
      danger: true,
      onSelect: async () => {
        if (
          data &&
          (await openConfirm({
            title: "Delete collection",
            message: `Delete the empty collection "${name}"?`,
            confirmLabel: "Delete",
            danger: true,
          }))
        ) {
          runLocalAction(() => deleteCollection(data.name, name));
        }
      },
    },
  ];

  return (
    <>
      <nav className="ld-nav">
        <NavItem
          icon={Icons.dashboard}
          label="Dashboard"
          active={page.type === "dashboard"}
          onClick={() => setSidebarState({ page: { type: "dashboard" } })}
        />
        <NavItem
          icon={Icons.settings}
          label="Settings"
          active={page.type === "settings"}
          onClick={() => setSidebarState({ page: { type: "settings" } })}
        />
        <NavItem
          icon={Icons.trash}
          label="Trash"
          active={page.type === "trash"}
          onClick={() => setSidebarState({ page: { type: "trash" } })}
        />
      </nav>

      <div className="ld-collections-header">
        <span>Collections</span>
        <button
          type="button"
          className="ld-plus-button"
          disabled={!data}
          aria-label="Create collection"
          title="Create collection"
          onClick={async () => {
            const name = await promptName({
              title: "Create collection",
              value: "",
              confirmLabel: "Create",
            });
            if (data && name) {
              runLocalAction(() => createCollection(data.name, name));
            }
          }}
        >
          {Icons.plus}
        </button>
      </div>

      <div className="ld-list ld-list--collections">
        {data?.collections.map((collection) => (
          <div
            key={collection.name}
            className={clsx("ld-collection-item", {
              "ld-collection-item--active":
                page.type === "collection" && page.name === collection.name,
              "ld-collection-item--private":
                collection.name === DEFAULT_COLLECTION_NAME,
            })}
          >
            <button
              type="button"
              className="ld-collection-item__main"
              onClick={() =>
                setSidebarState({
                  page: { type: "collection", name: collection.name },
                })
              }
            >
              <span className="ld-nav-item__icon">
                <CollectionIcon name={collection.name} />
              </span>
              <span className="ld-collection-item__name">
                {collection.name}
              </span>
            </button>
            <MenuButton
              className="ld-icon-button ld-collection-item__menu"
              title="More"
              entries={() => collectionMenu(collection.name)}
            >
              {Icons.dots}
            </MenuButton>
          </div>
        ))}
      </div>
    </>
  );
};

// -----------------------------------------------------------------------------
// sidebar
// -----------------------------------------------------------------------------

export const LocalDrawingsSidebar = ({
  api,
  isCollaborating,
}: {
  api: ExcalidrawImperativeAPI | null;
  isCollaborating: boolean;
}) => {
  const sidebar = useAtomValue(sidebarStateAtom);
  const info = useAtomValue(rootInfoAtom);
  const revision = useAtomValue(drawingsRevisionAtom);
  const activeWorkspace = useAtomValue(activeWorkspaceAtom);
  const setQuickSearchOpen = useSetAtom(quickSearchOpenAtom);

  useEffect(() => {
    refreshLocalDrawings();
  }, [revision, activeWorkspace]);

  useEffect(() => {
    const onFocus = () => refreshLocalDrawings();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!sidebar.open && sidebar.mode === "editor") {
    return null;
  }

  const userName = info?.user.name || "";

  return (
    <div className="ld-sidebar-column">
      <aside className="ld-sidebar">
        <WorkspaceHeader />

        <button
          type="button"
          className="ld-quick-search"
          onClick={() => setQuickSearchOpen(true)}
        >
          {Icons.search}
          <span>Quick search</span>
          <kbd>⌘P</kbd>
        </button>

        {sidebar.mode === "editor" ? (
          <>
            <nav className="ld-nav">
              <NavItem
                icon={Icons.dashboard}
                label="Dashboard"
                onClick={() =>
                  setSidebarState({
                    mode: "browse",
                    page: { type: "dashboard" },
                  })
                }
              />
            </nav>
            <CollectionView api={api} isCollaborating={isCollaborating} />
          </>
        ) : (
          <NavView api={api} />
        )}

        <div className="ld-sidebar__footer">
          <Avatar
            name={userName || "?"}
            color={USER_AVATAR_COLOR}
            className="ld-avatar--user"
          />
          <span
            className="ld-sidebar__user-name"
            title={info?.user.email || ""}
          >
            {userName}
          </span>
          <MenuButton
            className="ld-bell-button"
            title="Notifications"
            placement="bottom-center"
            entries={[{ type: "label", label: "No notifications" }]}
          >
            {Icons.bell}
          </MenuButton>
        </div>
      </aside>
    </div>
  );
};

/** rendered in the editor's top-left corner: sidebar toggle + scene name */
export const LocalDrawingsTopLeftUI = () => {
  const sidebar = useAtomValue(sidebarStateAtom);
  const currentPath = useAtomValue(currentDrawingPathAtom);
  const name = currentPath?.split("/")[2];
  return (
    <>
      <button
        type="button"
        className="ld-toolbar-button"
        onClick={() => setSidebarState({ open: !sidebar.open })}
        title={sidebar.open ? "Hide sidebar" : "Show sidebar"}
        aria-label={sidebar.open ? "Hide sidebar" : "Show sidebar"}
      >
        {Icons.sidebar}
      </button>
      {name && (
        <span className="ld-scene-title" title={name}>
          {name}
        </span>
      )}
    </>
  );
};
