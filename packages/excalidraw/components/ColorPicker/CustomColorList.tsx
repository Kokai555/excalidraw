import clsx from "clsx";
import { useEffect, useRef } from "react";

import type { Theme } from "@excalidraw/element/types";

import { useAtom } from "../../editor-jotai";

import HotkeyLabel from "./HotkeyLabel";
import {
  activeColorPickerSectionAtom,
  getColorPickerDisplayColor,
} from "./colorPickerUtils";

import { useColorPickerDnD } from "./colorTopPicksDnD";

import type { ColorPickerType } from "./colorPickerUtils";

interface CustomColorListProps {
  theme: Theme;
  /** the colors' use, which decides how they show in dark mode */
  type?: ColorPickerType;
  colors: string[];
  color: string | null;
  onChange: (color: string) => void;
  label: string;
}

export const CustomColorList = ({
  theme,
  type,
  colors,
  color,
  onChange,
  label,
}: CustomColorListProps) => {
  const [activeColorPickerSection, setActiveColorPickerSection] = useAtom(
    activeColorPickerSectionAtom,
  );
  const dnd = useColorPickerDnD();

  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (btnRef.current) {
      btnRef.current.focus();
    }
  }, [color, activeColorPickerSection]);

  return (
    <div className="color-picker-content--default">
      {colors.map((c, i) => {
        const displayColor = getColorPickerDisplayColor(c, type, theme);
        return (
          <button
            ref={color === c ? btnRef : undefined}
            tabIndex={-1}
            type="button"
            className={clsx(
              "color-picker__button color-picker__button--large has-outline",
              {
                active: color === c,
                "is-transparent": c === "transparent" || !c,
              },
            )}
            onClick={() => {
              onChange(c);
              setActiveColorPickerSection("custom");
            }}
            onPointerDown={
              dnd ? (event) => dnd.startSourceDrag(event, c) : undefined
            }
            title={c}
            aria-label={label}
            style={{ "--swatch-color": displayColor }}
            key={i}
          >
            <div className="color-picker__button-outline" />
            <HotkeyLabel color={displayColor} keyLabel={i + 1} />
          </button>
        );
      })}
    </div>
  );
};
