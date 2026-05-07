import type { ParsedArtifactFile, ParsedVar } from './parsed-artifact.types.js';

// ── Shared ────────────────────────────────────────────────────────────────────

/**
 * Plain-data snapshot of a parsed artifact file, safe to transmit over the
 * `postMessage` / `onDidReceiveMessage` boundary (no methods, no circular refs).
 *
 * Structurally identical to `ParsedArtifactFile` — defined as an alias so
 * message types can reference it without importing the parser type directly.
 *
 * @example
 * const msg: FileUpdatedMsg = { command: 'fileUpdated', artifact: parsedArtifact };
 */
export type SerializedArtifact = ParsedArtifactFile;

// ── Webview → Extension ───────────────────────────────────────────────────────

/**
 * Webview notifies the extension that the user began editing a section.
 * The extension should call `PreviewModeController.startEditingSection`.
 *
 * @example
 * vscode.postMessage({ command: 'startEdit', section: 'title' });
 */
export interface StartEditMsg {
    command: 'startEdit';
    section: 'title' | 'description' | 'varDefaults';
}

/**
 * Webview saves an edited `title` value.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'title', value: 'New Title' });
 */
export interface SaveSectionTitleMsg {
    command: 'saveSection';
    section: 'title';
    value: string;
}

/**
 * Webview saves an edited `description` value.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'description', value: 'Updated.' });
 */
export interface SaveSectionDescriptionMsg {
    command: 'saveSection';
    section: 'description';
    value: string;
}

/**
 * Webview saves updated variable default values.
 *
 * @example
 * vscode.postMessage({ command: 'saveSection', section: 'varDefaults', value: { 'VK-host': 'localhost' } });
 */
export interface SaveSectionVarDefaultsMsg {
    command: 'saveSection';
    section: 'varDefaults';
    value: Record<string, string>;
}

/**
 * Union of all `saveSection` message variants, discriminated by `section`.
 *
 * @example
 * function handle(msg: SaveSectionMsg) {
 *   if (msg.section === 'varDefaults') { msg.value; // Record<string,string> }
 * }
 */
export type SaveSectionMsg =
    | SaveSectionTitleMsg
    | SaveSectionDescriptionMsg
    | SaveSectionVarDefaultsMsg;

/**
 * Webview cancels an in-progress section edit without saving.
 *
 * @example
 * vscode.postMessage({ command: 'cancelEdit', section: 'title' });
 */
export interface CancelEditMsg {
    command: 'cancelEdit';
    section: string;
}

/**
 * Webview requests that the code area switch to a `<textarea>` for inline editing
 * (`quickEdit` mode).
 *
 * @example
 * vscode.postMessage({ command: 'quickEdit' });
 */
export interface QuickEditMsg {
    command: 'quickEdit';
}

/**
 * Webview requests that the extension open the artifact code in a real VS Code
 * editor tab via `TempDocument` (`fullEdit` mode).
 *
 * @example
 * vscode.postMessage({ command: 'fullEdit' });
 */
export interface FullEditMsg {
    command: 'fullEdit';
}

/**
 * Webview requests that the extension return from `quickEdit` back to `preview` mode.
 *
 * @example
 * vscode.postMessage({ command: 'backToPreview' });
 */
export interface BackToPreviewMsg {
    command: 'backToPreview';
}

/**
 * Webview confirms the insert, providing resolved `<VK-xxx>` variable values.
 * The extension reads the code (from the temp editor or inline textarea) and
 * calls `performInsert` with these values.
 *
 * @example
 * vscode.postMessage({ command: 'insert', vars: { 'VK-host': 'localhost' } });
 */
export interface InsertMsg {
    command: 'insert';
    vars: Record<string, string>;
}

/**
 * Webview cancels the entire artifact insert operation.
 *
 * @example
 * vscode.postMessage({ command: 'cancel' });
 */
export interface CancelMsg {
    command: 'cancel';
}

/**
 * Union of every message the webview can send to the extension.
 *
 * @example
 * panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMsg) => { ... });
 */
export type WebviewToExtensionMsg =
    | StartEditMsg
    | SaveSectionMsg
    | CancelEditMsg
    | QuickEditMsg
    | FullEditMsg
    | BackToPreviewMsg
    | InsertMsg
    | CancelMsg;

// ── Extension → Webview ───────────────────────────────────────────────────────

/**
 * Extension acknowledges a `saveSection` operation and reports success or failure.
 *
 * @example
 * panel.webview.postMessage({ command: 'sectionSaved', section: 'title', success: true });
 */
export interface SectionSavedMsg {
    command: 'sectionSaved';
    section: string;
    success: boolean;
}

/**
 * Extension pushes an updated `<VK-xxx>` var list to the webview after the user
 * edits the code in `fullEdit` mode (debounced, triggered by `onDidChangeTextDocument`).
 *
 * @example
 * panel.webview.postMessage({ command: 'updateVars', vars: extractVars(code) });
 */
export interface UpdateVarsMsg {
    command: 'updateVars';
    vars: ParsedVar[];
}

/**
 * Extension sends refreshed parsed artifact data to the webview after a `.md` file
 * write — e.g. after `patchFrontmatterField` or `patchVarDefaults` persists a change.
 *
 * @example
 * panel.webview.postMessage({ command: 'fileUpdated', artifact: parsedArtifact });
 */
export interface FileUpdatedMsg {
    command: 'fileUpdated';
    artifact: SerializedArtifact;
}

/**
 * Union of every message the extension can send to the webview.
 *
 * @example
 * window.addEventListener('message', (e: MessageEvent<ExtensionToWebviewMsg>) => { ... });
 */
export type ExtensionToWebviewMsg =
    | SectionSavedMsg
    | UpdateVarsMsg
    | FileUpdatedMsg;
