import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icons } from "./icons";

import type { ReactNode } from "react";

export type MenuEntry =
  | {
      type?: "item";
      label: ReactNode;
      icon?: ReactNode;
      onSelect?: () => void;
      danger?: boolean;
      /** shows a check mark column (checked or empty) */
      checked?: boolean;
      disabled?: boolean;
      active?: boolean;
      className?: string;
      submenu?: MenuEntry[];
    }
  | { type: "separator" }
  | { type: "label"; label: ReactNode }
  | { type: "custom"; content: ReactNode };

type Placement = "bottom-center" | "bottom-start" | "right-start";

const GAP = 6;
const VIEWPORT_MARGIN = 8;

const computePosition = (
  anchor: DOMRect,
  menu: { width: number; height: number },
  placement: Placement,
) => {
  let left: number;
  let top: number;
  if (placement === "right-start") {
    left = anchor.right + 2;
    top = anchor.top - 6;
    if (left + menu.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchor.left - menu.width - 2;
    }
  } else {
    top = anchor.bottom + GAP;
    left =
      placement === "bottom-center"
        ? anchor.left + anchor.width / 2 - menu.width / 2
        : anchor.left;
    if (top + menu.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, anchor.top - GAP - menu.height);
    }
  }
  left = Math.min(
    Math.max(VIEWPORT_MARGIN, left),
    window.innerWidth - menu.width - VIEWPORT_MARGIN,
  );
  top = Math.min(
    Math.max(VIEWPORT_MARGIN, top),
    window.innerHeight - menu.height - VIEWPORT_MARGIN,
  );
  return { left, top };
};

export const Menu = ({
  anchor,
  entries,
  onClose,
  placement = "bottom-center",
  className,
  width,
  isSubmenu = false,
}: {
  anchor: HTMLElement;
  entries: MenuEntry[];
  onClose: () => void;
  placement?: Placement;
  className?: string;
  width?: number;
  isSubmenu?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [submenu, setSubmenu] = useState<{
    index: number;
    anchor: HTMLElement;
  } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (!ref.current) {
        return;
      }
      setPosition(
        computePosition(
          anchor.getBoundingClientRect(),
          {
            width: ref.current.offsetWidth,
            height: ref.current.offsetHeight,
          },
          placement,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor, placement, entries]);

  useEffect(() => {
    if (isSubmenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        anchor.contains(target) ||
        (target instanceof Element && target.closest(".ld-menu"))
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose, isSubmenu]);

  const hasChecks = entries.some(
    (entry) => (!entry.type || entry.type === "item") && "checked" in entry,
  );

  return createPortal(
    <div
      ref={ref}
      className={clsx("ld-menu", className)}
      role="menu"
      // React bubbles events through portals to the component tree, so
      // clicks here would also reach e.g. the list item that opened the menu
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        width,
      }}
    >
      {entries.map((entry, index) => {
        if (entry.type === "separator") {
          return <div key={index} className="ld-menu__separator" />;
        }
        if (entry.type === "label") {
          return (
            <div key={index} className="ld-menu__label">
              {entry.label}
            </div>
          );
        }
        if (entry.type === "custom") {
          return <div key={index}>{entry.content}</div>;
        }
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={clsx("ld-menu__item", entry.className, {
              "ld-menu__item--active": entry.active,
              "ld-menu__item--danger": entry.danger,
              "ld-menu__item--open": submenu?.index === index,
            })}
            disabled={entry.disabled}
            onPointerEnter={(event) => {
              if (entry.submenu) {
                setSubmenu({ index, anchor: event.currentTarget });
              } else {
                setSubmenu(null);
              }
            }}
            onClick={(event) => {
              if (entry.submenu) {
                setSubmenu({ index, anchor: event.currentTarget });
                return;
              }
              onClose();
              entry.onSelect?.();
            }}
          >
            {hasChecks && (
              <span className="ld-menu__check">
                {entry.checked ? Icons.check : null}
              </span>
            )}
            {entry.icon && <span className="ld-menu__icon">{entry.icon}</span>}
            <span className="ld-menu__text">{entry.label}</span>
            {entry.submenu && (
              <span className="ld-menu__chevron">{Icons.chevronRight}</span>
            )}
          </button>
        );
      })}
      {submenu &&
        (() => {
          const entry = entries[submenu.index];
          return (!entry.type || entry.type === "item") && entry.submenu ? (
            <Menu
              anchor={submenu.anchor}
              entries={entry.submenu}
              placement="right-start"
              onClose={onClose}
              isSubmenu
            />
          ) : null;
        })()}
    </div>,
    document.body,
  );
};

/** a button that toggles a menu anchored to itself */
export const MenuButton = ({
  className,
  entries,
  children,
  title,
  placement,
  width,
  menuClassName,
  onOpenChange,
}: {
  className?: string;
  entries: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
  title?: string;
  placement?: Placement;
  width?: number;
  menuClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const setOpen = (element: HTMLElement | null) => {
    setAnchor(element);
    onOpenChange?.(!!element);
  };
  return (
    <>
      <button
        type="button"
        className={clsx(className, { "is-open": !!anchor })}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(anchor ? null : event.currentTarget);
        }}
      >
        {children}
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          entries={typeof entries === "function" ? entries() : entries}
          onClose={() => setOpen(null)}
          placement={placement}
          width={width}
          className={menuClassName}
        />
      )}
    </>
  );
};
