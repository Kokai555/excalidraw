import { applyDarkModeFilterToStroke, THEME } from "@excalidraw/common";

import {
  getTextCaretPosition,
  getTextElementLines,
  getTextLineLeft,
  hasLineStyles,
} from "@excalidraw/element";

import type { RenderEnvironment, TextElementLine } from "@excalidraw/element";
import type { ExcalidrawTextElement, Theme } from "@excalidraw/element/types";

/** on the editor while its text is shown by the mirror */
export const STYLED_TEXT_EDITOR_CLASS = "excalidraw-wysiwyg--styled";

const px = (value: number) => `${value}px`;

/**
 * Shows a text with line styles (see `textLineStyles.ts`) while it's being
 * edited, laid out as the canvas renders it: a textarea can only show a
 * single style. The textarea stays the editor (input, keyboard, selection);
 * it just turns invisible, and the mirror below it draws the lines, the
 * caret and the selection. Texts without line styles keep the textarea's
 * own rendering.
 */
export const createStyledTextMirror = (
  editable: HTMLTextAreaElement,
  opts: {
    getElement: () => ExcalidrawTextElement | null;
    getTheme: () => Theme;
    getZoom: () => number;
    renderEnvironment?: RenderEnvironment;
  },
) => {
  const ownerDocument = editable.ownerDocument;
  const create = (className: string) => {
    const element = ownerDocument.createElement("div");
    element.className = className;
    return element;
  };

  const root = create("excalidraw-wysiwyg-mirror");
  root.setAttribute("aria-hidden", "true");
  const selectionLayer = create("excalidraw-wysiwyg-mirror__layer");
  const linesLayer = create("excalidraw-wysiwyg-mirror__layer");
  const caret = create("excalidraw-wysiwyg-mirror__caret");
  root.append(selectionLayer, linesLayer, caret);

  let lines: TextElementLine[] = [];
  let element: ExcalidrawTextElement | null = null;

  const isActive = () => root.isConnected;

  const unmount = () => {
    root.remove();
    editable.classList.remove(STYLED_TEXT_EDITOR_CLASS);
  };

  const getColor = (line: TextElementLine) =>
    applyDarkModeFilterToStroke(
      line.strokeColor,
      opts.getTheme() === THEME.DARK,
    );

  const updateSelection = () => {
    if (!element || !isActive()) {
      return;
    }
    const env = opts.renderEnvironment;
    const { selectionStart: start, selectionEnd: end } = editable;
    selectionLayer.replaceChildren();

    if (start === end) {
      const { line, x } = getTextCaretPosition(element, lines, start, env);
      Object.assign(caret.style, {
        display: ownerDocument.activeElement === editable ? "" : "none",
        left: px(x),
        top: px(line.top),
        height: px(line.height),
        width: px(1.5 / opts.getZoom()),
        backgroundColor: getColor(line),
        // restart blinking, so it shows while moving
        animation: "none",
      });
      void caret.offsetWidth;
      caret.style.animation = "";
      return;
    }

    caret.style.display = "none";
    for (const line of lines) {
      const from = Math.max(start, line.start);
      const to = Math.min(end, line.end);
      // the line break after the line is selected too
      const selectsBreak = start <= line.end && end > line.end;
      if (from > to || (from === to && !selectsBreak)) {
        continue;
      }
      const x1 = getTextCaretPosition(element, [line], from, env).x;
      let x2 = getTextCaretPosition(element, [line], to, env).x;
      if (selectsBreak) {
        x2 += line.fontSize * 0.3;
      }
      const highlight = create("excalidraw-wysiwyg-mirror__selection");
      Object.assign(highlight.style, {
        left: px(x1),
        top: px(line.top),
        width: px(Math.max(0, x2 - x1)),
        height: px(line.height),
      });
      selectionLayer.append(highlight);
    }
  };

  /** re-renders the text (call when the element or the editor's box changed) */
  const update = () => {
    element = opts.getElement();
    if (!element || !hasLineStyles(element) || !editable.parentNode) {
      if (isActive()) {
        unmount();
      }
      return;
    }
    if (!isActive()) {
      editable.before(root);
      editable.classList.add(STYLED_TEXT_EDITOR_CLASS);
    }

    // the editor's box (position, size, zoom & rotation)
    const { left, top, width, height, transform, transformOrigin } =
      editable.style;
    Object.assign(root.style, {
      left,
      top,
      width,
      height,
      transform,
      transformOrigin,
    });

    const textElement = element;
    lines = getTextElementLines(textElement);
    linesLayer.replaceChildren(
      ...lines.map((line) => {
        const lineElement = create("excalidraw-wysiwyg-mirror__line");
        lineElement.textContent = line.text;
        Object.assign(lineElement.style, {
          left: px(getTextLineLeft(textElement, line, opts.renderEnvironment)),
          top: px(line.top),
          height: px(line.height),
          lineHeight: px(line.height),
          font: line.font,
          color: getColor(line),
          opacity: `${line.opacity / 100}`,
        });
        return lineElement;
      }),
    );
    updateSelection();
  };

  return {
    /** whether the mirror shows the text (it has line styles) */
    isActive,
    /** the laid out lines, while active */
    getLines: () => lines,
    update,
    updateSelection,
    destroy: unmount,
  };
};
