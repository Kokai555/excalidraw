import { FONT_FAMILY } from "@excalidraw/common";

import { setCustomTextMetricsProvider } from "../src/textMeasurements";
import {
  getSelectedLineRange,
  getTextCaretPosition,
  getTextElementLines,
  getTextOffsetAtPoint,
  mapWrappedLinesToParagraphs,
  measureTextElementText,
  normalizeLineStyles,
  patchLineStyles,
  remapLineStyles,
  setTextEditorSelection,
  wrapTextElementText,
} from "../src/textLineStyles";

import type { ExcalidrawTextElement, TextLineStyle } from "../src/types";

// `measureText` width is mocked to `text.length * fontSize` (jest-canvas-mock)
const textElement = (
  originalText: string,
  lineStyles: readonly (TextLineStyle | null)[] | null = null,
) =>
  ({
    id: "text",
    text: originalText,
    originalText,
    fontSize: 10,
    fontFamily: FONT_FAMILY.Cascadia,
    lineHeight: 1.25,
    strokeColor: "#000000",
    textAlign: "left",
    opacity: 100,
    width: 0,
    lineStyles,
  } as unknown as ExcalidrawTextElement);

const RED: TextLineStyle = { strokeColor: "#ff0000" };
const GREEN: TextLineStyle = { strokeColor: "#00ff00" };
const BIG: TextLineStyle = { fontScale: 2 };

describe("remapLineStyles", () => {
  const styles = [RED, GREEN];

  it("keeps styles when editing within a line", () => {
    expect(remapLineStyles(styles, "ab\ncd", "abX\ncd", 3)).toEqual(styles);
  });

  it("gives a line added with Enter the style of the line it was added from", () => {
    // Enter at the end of the first line
    expect(remapLineStyles(styles, "ab\ncd", "ab\n\ncd", 3)).toEqual([
      RED,
      RED,
      GREEN,
    ]);
    // Enter at the start of the second line
    expect(remapLineStyles(styles, "ab\ncd", "ab\n\ncd", 4)).toEqual([
      RED,
      GREEN,
      GREEN,
    ]);
  });

  it("keeps the first line's style when lines are merged", () => {
    // Backspace at the start of the second line
    expect(remapLineStyles(styles, "ab\ncd", "abcd", 2)).toEqual([RED]);
    expect(remapLineStyles([null, GREEN], "ab\ncd", "abcd", 2)).toEqual(null);
  });

  it("moves styles of following lines when lines are removed", () => {
    expect(remapLineStyles([RED, null, GREEN], "a\nb\nc", "a\nc", 2)).toEqual([
      RED,
      GREEN,
    ]);
  });

  it("styles pasted lines like the line they're pasted into", () => {
    expect(remapLineStyles(styles, "ab\ncd", "aX\nY\nZb\ncd", 6)).toEqual([
      RED,
      RED,
      RED,
      GREEN,
    ]);
  });

  it("works without the caret", () => {
    expect(remapLineStyles(styles, "ab\ncd", "ab\ncd\nef")).toEqual([
      RED,
      GREEN,
      GREEN,
    ]);
    // the first line deleted
    expect(remapLineStyles(styles, "ab\ncd", "cd")).toEqual([GREEN]);
  });
});

describe("patchLineStyles", () => {
  it("sets and removes overrides on a range of lines", () => {
    const element = textElement("a\nb\nc");
    const styled = patchLineStyles(element, 1, 2, {
      strokeColor: "#ff0000",
      fontScale: 2,
    });
    expect(styled).toEqual([
      null,
      { strokeColor: "#ff0000", fontScale: 2 },
      { strokeColor: "#ff0000", fontScale: 2 },
    ]);

    // the element's own values remove the override
    expect(
      patchLineStyles(textElement("a\nb\nc", styled), 1, 1, {
        strokeColor: "#000000",
        fontScale: 1,
      }),
    ).toEqual([null, null, { strokeColor: "#ff0000", fontScale: 2 }]);
  });
});

describe("normalizeLineStyles", () => {
  it("drops invalid values and trailing empty lines", () => {
    expect(
      normalizeLineStyles([
        { fontScale: -1, strokeColor: 5, textAlign: "middle", opacity: 150 },
        { foo: 1 },
        null,
      ]),
    ).toEqual([{ opacity: 100 }]);
    expect(normalizeLineStyles([null, {}])).toBe(null);
    expect(normalizeLineStyles("nope")).toBe(null);
    expect(normalizeLineStyles([RED, GREEN, RED], 2)).toEqual([RED, GREEN]);
  });
});

describe("layout", () => {
  // widths proportional to the font size: 1em per character
  beforeAll(() =>
    setCustomTextMetricsProvider({
      getLineWidth: (text, font) => text.length * parseFloat(font),
    }),
  );
  afterAll(() => setCustomTextMetricsProvider(undefined));

  it("maps wrapped lines to the lines they were wrapped from", () => {
    expect(
      mapWrappedLinesToParagraphs("Hello\nworld\n\nfoo", "Hello world\n\nfoo"),
    ).toEqual([
      { text: "Hello", paragraph: 0, start: 0, end: 5 },
      // the space at the split is trimmed
      { text: "world", paragraph: 0, start: 6, end: 11 },
      { text: "", paragraph: 1, start: 12, end: 12 },
      { text: "foo", paragraph: 2, start: 13, end: 16 },
    ]);
  });

  it("finds caret positions and the offsets at points", () => {
    const element = {
      ...textElement("ab\nabcd", [{ textAlign: "center" }, BIG]),
      width: 80,
    };
    const lines = getTextElementLines({
      ...element,
      text: element.originalText,
    });
    // "ab" (20px wide) centered in 80px: from 30 to 50
    expect(getTextCaretPosition(element, lines, 1)).toMatchObject({
      line: { paragraph: 0 },
      x: 40,
    });
    // second line, 20px per character, left aligned
    expect(getTextCaretPosition(element, lines, 5)).toMatchObject({
      line: { paragraph: 1 },
      x: 40,
    });
    expect(getTextOffsetAtPoint(element, lines, 31, 5)).toBe(0);
    expect(getTextOffsetAtPoint(element, lines, 49, 5)).toBe(2);
    // below the first line (12.5px high): the second, 2nd character
    expect(getTextOffsetAtPoint(element, lines, 29, 20)).toBe(4);
    // past the last line
    expect(getTextOffsetAtPoint(element, lines, 500, 500)).toBe(7);
  });

  it("wraps and measures each line with its own font size", () => {
    const element = textElement("abcd\nabcd", [null, BIG]);
    // 4 chars: 40px at 10px, 80px at 20px
    expect(wrapTextElementText(element, element.originalText, 50)).toBe(
      "abcd\nab\ncd",
    );
    expect(measureTextElementText(element, "abcd\nabcd")).toEqual({
      width: 80,
      height: 10 * 1.25 + 20 * 1.25,
    });

    const lines = getTextElementLines({ ...element, text: "abcd\nab\ncd" });
    expect(lines.map((line) => [line.text, line.fontSize, line.top])).toEqual([
      ["abcd", 10, 0],
      ["ab", 20, 12.5],
      ["cd", 20, 37.5],
    ]);
  });
});

describe("getSelectedLineRange", () => {
  afterEach(() => setTextEditorSelection(null));

  const select = (start: number, end = start) =>
    setTextEditorSelection({ elementId: "text", start, end });

  it("returns the lines the selection touches", () => {
    const element = textElement("ab\ncd\nef");
    select(4);
    expect(getSelectedLineRange(element)).toEqual({ from: 1, to: 1 });
    select(1, 4);
    expect(getSelectedLineRange(element)).toEqual({ from: 0, to: 1 });
    // ends at the start of the 3rd line → not included
    select(3, 6);
    expect(getSelectedLineRange(element)).toEqual({ from: 1, to: 1 });
  });

  it("returns null when the whole text is affected", () => {
    select(0, 8);
    expect(getSelectedLineRange(textElement("ab\ncd\nef"))).toBe(null);
    select(1);
    expect(getSelectedLineRange(textElement("single line"))).toBe(null);
    setTextEditorSelection({ elementId: "other", start: 4, end: 4 });
    expect(getSelectedLineRange(textElement("ab\ncd\nef"))).toBe(null);
  });
});
