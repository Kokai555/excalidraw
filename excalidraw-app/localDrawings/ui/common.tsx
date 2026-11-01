import clsx from "clsx";
import { useEffect, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../../app-jotai";
import {
  duplicateDrawing,
  exportDrawing,
  INVALID_NAME_MESSAGE,
  isValidName,
  LocalDrawingsAPI,
  moveDrawing,
  renameDrawing,
  rootInfoAtom,
  runLocalAction,
  showLocalToast,
  trashDrawing,
  workspaceDataAtom,
} from "../localDrawings";
import { DRAWING_FILE_EXTENSION } from "../constants";

import { openPrompt } from "./Dialogs";
import { Icons } from "./icons";

import type { DrawingMeta } from "../constants";
import type { MenuEntry } from "./Menu";

// -----------------------------------------------------------------------------
// time
// -----------------------------------------------------------------------------

/** "a few seconds ago", "an hour ago", "9 days ago", … */
export const formatTimeAgo = (time: number, now: number) => {
  const seconds = Math.max(0, (now - time) / 1000);
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const plural = (value: number, unit: string) =>
    `${Math.round(value)} ${unit}${Math.round(value) === 1 ? "" : "s"} ago`;
  if (seconds < 45) {
    return "a few seconds ago";
  }
  if (seconds < 90) {
    return "a minute ago";
  }
  if (minutes < 45) {
    return plural(minutes, "minute");
  }
  if (minutes < 90) {
    return "an hour ago";
  }
  if (hours < 22) {
    return plural(hours, "hour");
  }
  if (hours < 36) {
    return "a day ago";
  }
  if (days < 26) {
    return plural(days, "day");
  }
  if (days < 45) {
    return "a month ago";
  }
  if (days < 320) {
    return plural(days / 30.4, "month");
  }
  if (days < 548) {
    return "a year ago";
  }
  return plural(days / 365, "year");
};

/** re-renders periodically so relative times stay fresh */
export const useNow = (interval = 30_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    const onFocus = () => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [interval]);
  return now;
};

// -----------------------------------------------------------------------------
// avatars & thumbnails
// -----------------------------------------------------------------------------

export const USER_AVATAR_COLOR = "#1e4c40";

export const getInitial = (name: string) =>
  (name.trim()[0] || "?").toLocaleUpperCase();

export const Avatar = ({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) => (
  <span className={clsx("ld-avatar", className)} style={{ background: color }}>
    {getInitial(name)}
  </span>
);

export const DrawingThumbnail = ({
  drawing,
  className,
  children,
}: {
  drawing: DrawingMeta;
  className?: string;
  children?: React.ReactNode;
}) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [drawing.thumbnailVersion]);
  return (
    <span className={clsx("ld-thumbnail", className)}>
      {drawing.thumbnailVersion !== null && !failed && (
        <img
          src={LocalDrawingsAPI.thumbnailUrl(
            drawing.path,
            drawing.thumbnailVersion,
          )}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {children}
    </span>
  );
};

// -----------------------------------------------------------------------------
// drawing context menu (sidebar items & cards)
// -----------------------------------------------------------------------------

export const promptName = async (opts: {
  title: string;
  value: string;
  confirmLabel: string;
}) => {
  const value = await openPrompt({
    ...opts,
    validate: (name) => (isValidName(name) ? null : INVALID_NAME_MESSAGE),
  });
  return value?.trim() || null;
};

export const getDrawingMenuEntries = (
  drawing: DrawingMeta,
  api: ExcalidrawImperativeAPI | null,
): MenuEntry[] => {
  const data = appJotaiStore.get(workspaceDataAtom);
  const otherCollections =
    data?.collections.filter((col) => col.name !== drawing.collection) || [];
  const root = appJotaiStore.get(rootInfoAtom)?.root;
  const absolutePath = root
    ? `${root}/${drawing.path}${DRAWING_FILE_EXTENSION}`
    : null;

  return [
    {
      label: "Rename",
      icon: Icons.pencil,
      onSelect: async () => {
        const name = await promptName({
          title: "Rename scene",
          value: drawing.name,
          confirmLabel: "Rename",
        });
        if (name && name !== drawing.name) {
          runLocalAction(() => renameDrawing(api, drawing.path, name));
        }
      },
    },
    {
      label: "Share",
      icon: Icons.share,
      submenu: [
        {
          label: "Copy file path",
          icon: Icons.link,
          disabled: !absolutePath,
          onSelect: () =>
            runLocalAction(async () => {
              await navigator.clipboard.writeText(absolutePath!);
              showLocalToast("File path copied to clipboard");
            }),
        },
        {
          label: "Show in Finder",
          icon: Icons.folder,
          onSelect: () =>
            runLocalAction(() =>
              LocalDrawingsAPI.reveal({ path: drawing.path }),
            ),
        },
      ],
    },
    {
      label: "Quick export",
      icon: Icons.imageExport,
      submenu: [
        {
          label: "PNG",
          icon: Icons.imageExport,
          onSelect: () =>
            runLocalAction(() => exportDrawing(drawing.path, "png")),
        },
        {
          label: "SVG",
          icon: Icons.imageExport,
          onSelect: () =>
            runLocalAction(() => exportDrawing(drawing.path, "svg")),
        },
        {
          label: ".excalidraw",
          icon: Icons.file,
          onSelect: () =>
            runLocalAction(() => exportDrawing(drawing.path, "excalidraw")),
        },
      ],
    },
    {
      label: drawing.pinned ? "Unpin" : "Pin",
      icon: Icons.pin,
      onSelect: () =>
        runLocalAction(() =>
          LocalDrawingsAPI.setPinned(drawing.path, !drawing.pinned),
        ),
    },
    {
      label: "Duplicate",
      icon: Icons.duplicate,
      onSelect: () => runLocalAction(() => duplicateDrawing(drawing.path)),
    },
    {
      label: "Move",
      icon: Icons.move,
      disabled: !otherCollections.length,
      submenu: otherCollections.map((collection) => ({
        label: collection.name,
        icon: Icons.collection,
        onSelect: () =>
          runLocalAction(() => moveDrawing(api, drawing.path, collection.name)),
      })),
    },
    { type: "separator" },
    {
      label: "Move to trash",
      icon: Icons.trash,
      danger: true,
      onSelect: () =>
        runLocalAction(async () => {
          await trashDrawing(api, drawing.path);
          showLocalToast(`"${drawing.name}" moved to trash`);
        }),
    },
  ];
};
