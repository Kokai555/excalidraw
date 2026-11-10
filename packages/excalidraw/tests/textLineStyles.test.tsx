import React from "react";

import { KEYS } from "@excalidraw/common";

import { getNonDeletedElements } from "@excalidraw/element";

import type {
  ExcalidrawTextElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  actionChangeFontSize,
  actionChangeOpacity,
  actionChangeStrokeColor,
  actionChangeTextAlign,
} from "../actions/actionProperties";
import { Excalidraw } from "../index";
import { exportScene } from "../scene/export";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { getTextEditor } from "./queries/dom";
import { act, fireEvent, render, screen } from "./test-utils";

const { h } = window;

const TEXT = "Teszt\nSor1 Zöld\nSor2 Piros";

const getText = () =>
  h.elements.find(
    (element): element is ExcalidrawTextElement => element.type === "text",
  )!;

/** starts editing a 3-line text */
const editText = async () => {
  const text = API.createElement({
    type: "text",
    text: TEXT,
    fontSize: 20,
    strokeColor: "#1e1e1e",
  });
  API.setElements([text]);
  API.setSelectedElements([text]);
  Keyboard.keyPress(KEYS.ENTER);
  const editor = await getTextEditor();
  // the editor arms its submit-on-blur a tick after it's created
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return editor;
};

const select = (editor: HTMLTextAreaElement, start: number, end = start) => {
  editor.setSelectionRange(start, end);
  fireEvent.select(editor);
};

describe("per-line text styles", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  it("styles the caret's line while editing", async () => {
    const editor = await editText();
    // "Sor1 Zöld"
    select(editor, 8);

    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#2f9e44",
      });
      h.app.actionManager.executeAction(actionChangeTextAlign, "ui", "center");
    });

    const text = getText();
    expect(text.strokeColor).toBe("#1e1e1e");
    expect(text.textAlign).toBe("left");
    expect(text.lineStyles).toEqual([
      null,
      { strokeColor: "#2f9e44", textAlign: "center" },
    ]);
  });

  it("shows the style of the caret's line in the styles panel", async () => {
    const editor = await editText();
    const isChecked = (testId: string) =>
      screen.queryByTestId<HTMLInputElement>(testId)?.checked;

    // "Teszt": large
    select(editor, 2);
    act(() => {
      h.app.actionManager.executeAction(actionChangeFontSize, "ui", 28);
    });
    expect(isChecked("fontSize-large")).toBe(true);

    // moving the caret to another line (no other change) updates the panel
    act(() => select(editor, 8));
    expect(isChecked("fontSize-medium")).toBe(true);
    expect(isChecked("fontSize-large")).toBe(false);

    act(() => select(editor, 2));
    expect(isChecked("fontSize-large")).toBe(true);
  });

  it("styles the lines the selection touches", async () => {
    const editor = await editText();
    const { height } = getText();
    // from "Sor1" to "Sor2"
    select(editor, 8, 18);

    act(() => {
      h.app.actionManager.executeAction(actionChangeFontSize, "ui", 28);
      h.app.actionManager.executeAction(actionChangeOpacity, "ui", 15);
    });

    const text = getText();
    expect(text.fontSize).toBe(20);
    expect(text.opacity).toBe(100);
    expect(text.lineStyles).toEqual([
      null,
      { fontScale: 1.4, opacity: 15 },
      { fontScale: 1.4, opacity: 15 },
    ]);
    // two of three lines grew by 40%
    expect(text.height).toBeCloseTo(height * (1 + (2 * 0.4) / 3));
  });

  it("styles the whole text when all of it is selected", async () => {
    const editor = await editText();
    select(editor, 8);
    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#e03131",
      });
    });
    expect(getText().lineStyles).toEqual([null, { strokeColor: "#e03131" }]);

    select(editor, 0, TEXT.length);
    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#1971c2",
      });
    });
    const text = getText();
    expect(text.strokeColor).toBe("#1971c2");
    // the whole text's color replaces the line's
    expect(text.lineStyles).toBe(null);
  });

  it("keeps styles on their lines as lines are added", async () => {
    const editor = await editText();
    select(editor, 8);
    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#2f9e44",
      });
    });

    // Enter at the end of the first line
    editor.value = "Teszt\n\nSor1 Zöld\nSor2 Piros";
    editor.setSelectionRange(6, 6);
    fireEvent.input(editor);

    expect(getText().lineStyles).toEqual([
      null,
      null,
      { strokeColor: "#2f9e44" },
    ]);
  });

  it("keeps the styles after editing, and exports them", async () => {
    const editor = await editText();
    select(editor, 20);
    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#e03131",
      });
    });
    Keyboard.keyPress(KEYS.ESCAPE, editor);

    expect(h.state.editingTextElement).toBe(null);
    expect(getText().lineStyles).toEqual([
      null,
      null,
      { strokeColor: "#e03131" },
    ]);

    const svg = await exportScene({
      type: "svg",
      data: { elements: getNonDeletedElements(h.elements), files: {} },
      config: { canvasBackgroundColor: false },
    });
    expect(
      [...svg.querySelectorAll("text")].map((text) => [
        text.textContent,
        text.getAttribute("fill"),
      ]),
    ).toEqual([
      ["Teszt", "#1e1e1e"],
      ["Sor1 Zöld", "#1e1e1e"],
      ["Sor2 Piros", "#e03131"],
    ]);
  });

  it("styles the whole text when not editing", async () => {
    const text = {
      ...API.createElement({ type: "text", text: TEXT }),
      lineStyles: [null, { strokeColor: "#2f9e44", textAlign: "center" }],
    } as NonDeleted<ExcalidrawTextElement>;
    API.setElements([text]);
    API.setSelectedElements([text]);

    act(() => {
      h.app.actionManager.executeAction(actionChangeStrokeColor, "ui", {
        color: "#e03131",
      });
    });

    expect(getText().strokeColor).toBe("#e03131");
    expect(getText().lineStyles).toEqual([null, { textAlign: "center" }]);
  });
});
