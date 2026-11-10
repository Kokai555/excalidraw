/**
 * Per-line styles of text elements.
 *
 * A text element may override its font size, color, alignment and opacity
 * for individual lines (paragraphs) of its `originalText`, stored in
 * `element.lineStyles[paragraphIndex]`. Lines the text wraps into take the
 * style of the line they were wrapped from.
 *
 * Elements without line styles take the regular (single style) code paths,
 * so the helpers here fall back to `wrapText` / `measureText`.
 */

import { getFontString } from "@excalidraw/common";

import {
  getLineHeightInPx,
  getLineWidth,
  measureText,
} from "./textMeasurements";
import { wrapText } from "./textWrapping";

import type { RenderEnvironment } from "./renderEnvironment";
import type {
  ExcalidrawTextElement,
  FontString,
  TextAlign,
  TextLineStyle,
} from "./types";

export type TextLineStyles = NonNullable<ExcalidrawTextElement["lineStyles"]>;

type LineStylesElement = Pick<
  ExcalidrawTextElement,
  | "lineStyles"
  | "originalText"
  | "fontSize"
  | "fontFamily"
  | "lineHeight"
  | "strokeColor"
  | "textAlign"
  | "opacity"
>;

export const TEXT_LINE_STYLE_KEYS: readonly (keyof TextLineStyle)[] = [
  "fontScale",
  "strokeColor",
  "textAlign",
  "opacity",
];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MIN_FONT_SCALE = 0.05;
const MAX_FONT_SCALE = 20;

const normalizeEOLs = (text: string) => text.replace(/\r\n?/g, "\n");

export const getTextParagraphs = (originalText: string) =>
  normalizeEOLs(originalText).split("\n");

/** the index of the paragraph (line of `text`) the offset is in */
export const getParagraphIndexAt = (text: string, offset: number) => {
  let index = 0;
  for (let i = 0; i < Math.min(offset, text.length); i++) {
    if (text[i] === "\n") {
      index++;
    }
  }
  return index;
};

const countLineBreaks = (text: string) => text.split("\n").length - 1;

/** drops unknown/invalid keys; `null` if nothing's left */
const sanitizeLineStyle = (style: unknown): TextLineStyle | null => {
  if (!style || typeof style !== "object") {
    return null;
  }
  const { fontScale, strokeColor, textAlign, opacity } = style as Record<
    string,
    unknown
  >;
  const result: Mutable<TextLineStyle> = {};
  if (
    typeof fontScale === "number" &&
    Number.isFinite(fontScale) &&
    fontScale > 0
  ) {
    result.fontScale = Math.min(
      Math.max(fontScale, MIN_FONT_SCALE),
      MAX_FONT_SCALE,
    );
  }
  if (typeof strokeColor === "string" && strokeColor) {
    result.strokeColor = strokeColor;
  }
  if (textAlign === "left" || textAlign === "center" || textAlign === "right") {
    result.textAlign = textAlign;
  }
  if (typeof opacity === "number" && Number.isFinite(opacity)) {
    result.opacity = Math.min(Math.max(opacity, 0), 100);
  }
  return Object.keys(result).length ? result : null;
};

/**
 * Normalizes line styles: invalid entries become `null`, trailing `null`s
 * and entries past `paragraphCount` are dropped. Returns `null` if no line
 * has a style.
 */
export const normalizeLineStyles = (
  lineStyles: unknown,
  paragraphCount?: number,
): TextLineStyles | null => {
  if (!Array.isArray(lineStyles)) {
    return null;
  }
  const result = lineStyles
    .slice(0, paragraphCount ?? lineStyles.length)
    .map(sanitizeLineStyle);
  while (result.length && result[result.length - 1] === null) {
    result.pop();
  }
  return result.length ? result : null;
};

export const hasLineStyles = (element: {
  lineStyles?: ExcalidrawTextElement["lineStyles"];
}) => !!element.lineStyles?.some((style) => !!style);

export type ResolvedLineStyle = {
  fontSize: number;
  strokeColor: string;
  textAlign: TextAlign;
  /** 0-100 */
  opacity: number;
};

/** the effective style of a paragraph of the element's `originalText` */
export const resolveLineStyle = (
  element: LineStylesElement,
  paragraph: number,
): ResolvedLineStyle => {
  const style = element.lineStyles?.[paragraph] ?? null;
  return {
    fontSize: style?.fontScale
      ? element.fontSize * style.fontScale
      : element.fontSize,
    strokeColor: style?.strokeColor ?? element.strokeColor,
    textAlign: style?.textAlign ?? element.textAlign,
    opacity: style?.opacity ?? element.opacity,
  };
};

const getParagraphFont = (element: LineStylesElement, paragraph: number) =>
  getFontString({
    fontSize: resolveLineStyle(element, paragraph).fontSize,
    fontFamily: element.fontFamily,
  });

/**
 * Pairs each line of the (wrapped) `text` with the paragraph of
 * `originalText` it was wrapped from. Wrapping only splits paragraphs (and
 * trims whitespace at the splits), so the lines are matched as consecutive
 * pieces of the paragraphs.
 */
export const mapWrappedLinesToParagraphs = (
  text: string,
  originalText: string,
): { text: string; paragraph: number }[] => {
  const lines = normalizeEOLs(text).split("\n");
  const paragraphs = getTextParagraphs(originalText);

  // every paragraph yields at least one line → nothing was wrapped
  if (lines.length === paragraphs.length) {
    return lines.map((line, paragraph) => ({ text: line, paragraph }));
  }

  const result: { text: string; paragraph: number }[] = [];
  let lineIndex = 0;
  for (
    let paragraph = 0;
    paragraph < paragraphs.length && lineIndex < lines.length;
    paragraph++
  ) {
    let rest = paragraphs[paragraph];
    do {
      const line = lines[lineIndex++];
      result.push({ text: line, paragraph });
      if (!rest.startsWith(line)) {
        rest = rest.trimStart();
      }
      if (!rest.startsWith(line)) {
        // out of sync (shouldn't happen): continue with the next paragraph
        rest = "";
        break;
      }
      rest = rest.slice(line.length);
    } while (rest.trim() && lineIndex < lines.length);
  }
  // (shouldn't happen) lines left over belong to the last paragraph
  while (lineIndex < lines.length) {
    result.push({
      text: lines[lineIndex++],
      paragraph: paragraphs.length - 1,
    });
  }
  return result;
};

export type TextElementLine = ResolvedLineStyle & {
  text: string;
  paragraph: number;
  font: FontString;
  /** offset of the line's top from the element's top */
  top: number;
  height: number;
};

/**
 * The lines of a text element as rendered, with their style & position.
 * `text` is the element's (wrapped) text by default.
 */
export const getTextElementLines = (
  element: LineStylesElement & Pick<ExcalidrawTextElement, "text">,
  text: string = element.text,
): TextElementLine[] => {
  let top = 0;
  return mapWrappedLinesToParagraphs(text, element.originalText).map(
    ({ text, paragraph }) => {
      const style = resolveLineStyle(element, paragraph);
      const height = getLineHeightInPx(style.fontSize, element.lineHeight);
      const line: TextElementLine = {
        ...style,
        text,
        paragraph,
        font: getFontString({
          fontSize: style.fontSize,
          fontFamily: element.fontFamily,
        }),
        top,
        height,
      };
      top += height;
      return line;
    },
  );
};

/** where a line is drawn from, for its alignment (canvas `textAlign`) */
export const getTextLineX = (
  element: Pick<ExcalidrawTextElement, "width">,
  line: Pick<TextElementLine, "textAlign">,
) =>
  line.textAlign === "center"
    ? element.width / 2
    : line.textAlign === "right"
    ? element.width
    : 0;

/**
 * The alpha to draw a line with, given the alpha the element is drawn with
 * (which includes the element's own opacity).
 */
export const getTextLineAlpha = (
  element: Pick<ExcalidrawTextElement, "opacity">,
  line: Pick<TextElementLine, "opacity">,
  elementAlpha: number,
) =>
  element.opacity > 0
    ? Math.min(1, (elementAlpha * line.opacity) / element.opacity)
    : 0;

/**
 * `wrapText()` for a text element: with line styles, each paragraph wraps
 * with its own font size. `originalText` must match the element's
 * `lineStyles`.
 */
export const wrapTextElementText = (
  element: LineStylesElement,
  originalText: string,
  maxWidth: number,
  env?: RenderEnvironment,
) => {
  if (!hasLineStyles(element)) {
    return wrapText(originalText, getFontString(element), maxWidth, env);
  }
  return getTextParagraphs(originalText)
    .map((paragraph, index) =>
      wrapText(paragraph, getParagraphFont(element, index), maxWidth, env),
    )
    .join("\n");
};

/**
 * `measureText()` for a text element's (wrapped) `text`, which must have been
 * wrapped from the element's `originalText`.
 */
export const measureTextElementText = (
  element: LineStylesElement,
  text: string,
  env?: RenderEnvironment,
) => {
  if (!hasLineStyles(element)) {
    return measureText(text, getFontString(element), element.lineHeight, env);
  }
  let width = 0;
  let height = 0;
  for (const line of getTextElementLines({ ...element, text })) {
    // empty lines still take a space's width (as in `measureText()`)
    width = Math.max(width, getLineWidth(line.text || " ", line.font, env));
    height += line.height;
  }
  return { width, height };
};

/**
 * Keeps line styles on their lines as `prevText` is edited into `nextText`.
 * Lines inserted by the edit take the style of the line the edit started in
 * (like pressing Enter in a word processor), merged lines keep the first
 * one's, and lines following removed lines keep their own.
 *
 * `caret`, the caret's offset in `nextText` after the edit, tells where the
 * edit was when that's ambiguous (e.g. which of two lines a new empty line
 * was added after).
 */
export const remapLineStyles = (
  lineStyles: ExcalidrawTextElement["lineStyles"],
  prevText: string,
  nextText: string,
  caret?: number | null,
): TextLineStyles | null => {
  if (!lineStyles?.length) {
    return null;
  }
  if (prevText === nextText) {
    return normalizeLineStyles(lineStyles, getTextParagraphs(nextText).length);
  }

  let prefix = 0;
  const maxPrefix = Math.min(prevText.length, nextText.length);
  while (prefix < maxPrefix && prevText[prefix] === nextText[prefix]) {
    prefix++;
  }

  let suffix: number;
  if (
    caret != null &&
    caret >= 0 &&
    caret <= nextText.length &&
    nextText.length - caret <= prevText.length &&
    prevText.endsWith(nextText.slice(caret))
  ) {
    // the edit ended at the caret
    suffix = nextText.length - caret;
    prefix = Math.min(prefix, caret, prevText.length - suffix);
  } else {
    suffix = 0;
    const maxSuffix = maxPrefix - prefix;
    while (
      suffix < maxSuffix &&
      prevText[prevText.length - 1 - suffix] ===
        nextText[nextText.length - 1 - suffix]
    ) {
      suffix++;
    }
  }

  const first = getParagraphIndexAt(prevText, prefix);
  const removedBreaks = countLineBreaks(
    prevText.slice(prefix, prevText.length - suffix),
  );
  const insertedBreaks = countLineBreaks(
    nextText.slice(prefix, nextText.length - suffix),
  );
  const prevCount = getTextParagraphs(prevText).length;

  // the last line the edit touches ends with the rest of the last removed
  // line; if nothing comes before that rest (e.g. whole lines were deleted),
  // it's still that line
  const inserted = nextText.slice(prefix, nextText.length - suffix);
  const lineStart = prevText.lastIndexOf("\n", prefix - 1) + 1;
  const beforeRest =
    insertedBreaks > 0
      ? inserted.slice(inserted.lastIndexOf("\n") + 1)
      : prevText.slice(lineStart, prefix) + inserted;

  const result: (TextLineStyle | null)[] = [];
  for (let i = 0; i < first; i++) {
    result.push(lineStyles[i] ?? null);
  }
  for (let i = 0; i <= insertedBreaks; i++) {
    const isLast = i === insertedBreaks;
    result.push(
      lineStyles[
        isLast && !beforeRest
          ? first + removedBreaks
          : first + Math.min(i, removedBreaks)
      ] ?? null,
    );
  }
  for (let i = first + removedBreaks + 1; i < prevCount; i++) {
    result.push(lineStyles[i] ?? null);
  }
  return normalizeLineStyles(result, getTextParagraphs(nextText).length);
};

export type TextLineStylePatch = {
  [K in keyof TextLineStyle]?: TextLineStyle[K] | null;
};

/**
 * Line styles with `patch` applied to paragraphs `from`…`to` (inclusive).
 * `null` values, and values the element itself has, remove the override.
 */
export const patchLineStyles = (
  element: LineStylesElement,
  from: number,
  to: number,
  patch: TextLineStylePatch,
): TextLineStyles | null => {
  const count = getTextParagraphs(element.originalText).length;
  const result: (TextLineStyle | null)[] = [];
  for (let i = 0; i < count; i++) {
    let style: Mutable<TextLineStyle> | null = element.lineStyles?.[i]
      ? { ...element.lineStyles[i] }
      : null;
    if (i >= from && i <= to) {
      style = { ...style };
      for (const key of TEXT_LINE_STYLE_KEYS) {
        if (!(key in patch)) {
          continue;
        }
        const value = patch[key];
        const isElementValue =
          key === "fontScale"
            ? value === 1
            : value === (element as Record<string, unknown>)[key];
        if (value == null || isElementValue) {
          delete style[key];
        } else {
          (style as Record<string, unknown>)[key] = value;
        }
      }
    }
    result.push(style);
  }
  return normalizeLineStyles(result, count);
};

/** line styles without the given overrides (e.g. after setting them on the whole element) */
export const clearLineStyleKeys = (
  lineStyles: ExcalidrawTextElement["lineStyles"],
  keys: readonly (keyof TextLineStyle)[],
): TextLineStyles | null => {
  if (!lineStyles) {
    return null;
  }
  return normalizeLineStyles(
    lineStyles.map((style) => {
      if (!style) {
        return null;
      }
      const next: Mutable<TextLineStyle> = { ...style };
      for (const key of keys) {
        delete next[key];
      }
      return next;
    }),
  );
};

// -----------------------------------------------------------------------------
// the text editor's selection
// -----------------------------------------------------------------------------

/**
 * The selection of the text being edited (offsets into its `originalText`),
 * set by the text editor. Style changes made while editing apply to the
 * lines it touches.
 */
let textEditorSelection: {
  elementId: ExcalidrawTextElement["id"];
  start: number;
  end: number;
} | null = null;

export const setTextEditorSelection = (
  selection: typeof textEditorSelection,
) => {
  textEditorSelection = selection;
};

export const getTextEditorSelection = (elementId: string) =>
  textEditorSelection?.elementId === elementId ? textEditorSelection : null;

/**
 * The paragraphs of the edited text the editor's selection touches (the
 * caret's line if nothing's selected), or `null` when a style change should
 * apply to the whole element: the text has a single line, the selection
 * covers all of it, or the element isn't being edited.
 */
export const getSelectedLineRange = (
  element: Pick<ExcalidrawTextElement, "id" | "originalText">,
): { from: number; to: number } | null => {
  const selection = getTextEditorSelection(element.id);
  if (!selection) {
    return null;
  }
  const text = normalizeEOLs(element.originalText);
  const count = getTextParagraphs(text).length;
  if (count < 2) {
    return null;
  }
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const from = getParagraphIndexAt(text, start);
  let to = getParagraphIndexAt(text, end);
  // a selection ending at the very start of a line doesn't include it
  if (end > start && to > from && text[end - 1] === "\n") {
    to--;
  }
  if (from === 0 && to === count - 1) {
    return null;
  }
  return { from, to };
};
