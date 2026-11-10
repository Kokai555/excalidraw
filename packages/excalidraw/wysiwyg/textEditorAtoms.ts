import { atom } from "../editor-jotai";

/**
 * The lines of the edited text the editor's selection touches (`"from-to"`,
 * `"all"` when style changes apply to the whole text), see
 * `getSelectedLineRange()`. The styles panel shows those lines' style, so it
 * re-renders as this changes.
 */
export const textEditorSelectedLinesAtom = atom<string | null>(null);
