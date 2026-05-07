import * as vscode from 'vscode';

/**
 * Manages the lifecycle of an untitled VS Code document used as a temporary
 * edit surface — typically to let the user review or modify artifact content
 * before it is inserted into the editor or terminal.
 *
 * @example
 * ```ts
 * const td  = new TempDocument();
 * const doc = await td.create('const x = 1;', 'javascript');
 * // user edits the document in the editor
 * const text = td.getContent();
 * await td.dispose();
 * ```
 */
export class TempDocument {

    private doc: vscode.TextDocument | undefined = undefined;
    private editor: vscode.TextEditor | undefined = undefined;
    private alive = false;

    // ── create ────────────────────────────────────────────────────────────────

    /**
     * Opens a new untitled document pre-populated with `code` and switches the
     * active editor to it so the user can start typing immediately.
     *
     * @param code     - Initial text content.
     * @param language - VS Code language identifier (e.g. `'javascript'`).
     *                   Defaults to `'plaintext'` when omitted or `undefined`.
     * @returns The underlying `vscode.TextDocument`.
     * @example
     * ```ts
     * const doc = await td.create('echo hello', 'shellscript');
     * ```
     */
    async create(code: string, language?: string): Promise<vscode.TextDocument> {
        this.doc = await vscode.workspace.openTextDocument({
            content: code,
            language: language ?? 'plaintext',
        });

        this.editor = await vscode.window.showTextDocument(this.doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false,
            preserveFocus: false,
        });

        this.alive = true;
        return this.doc;
    }

    // ── getContent ────────────────────────────────────────────────────────────

    /**
     * Returns the current text of the temporary document, including any edits
     * made by the user since `create` was called.
     *
     * @returns The full document text, or an empty string if the document has
     *          been disposed.
     * @throws {Error} When called before `create` has been invoked.
     * @example
     * ```ts
     * const text = td.getContent();
     * ```
     */
    getContent(): string {
        if (!this.alive || this.doc === undefined) {
            return '';
        }
        return this.doc.getText();
    }

    // ── dispose ───────────────────────────────────────────────────────────────

    /**
     * Closes the editor tab and reverts the document so VS Code does not prompt
     * the user to save. Safe to call multiple times — subsequent calls are no-ops.
     *
     * @returns A promise that resolves once the editor is closed.
     * @example
     * ```ts
     * await td.dispose();
     * ```
     */
    async dispose(): Promise<void> {
        if (!this.alive) {
            return;
        }

        this.alive = false;

        if (this.editor !== undefined) {
            // Reveal the editor so the revert command targets the right tab.
            await vscode.window.showTextDocument(this.editor.document, {
                viewColumn: this.editor.viewColumn,
                preserveFocus: false,
            });
        }

        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

        this.doc = undefined;
        this.editor = undefined;
    }

    // ── isAlive ───────────────────────────────────────────────────────────────

    /**
     * Reports whether the document is currently open and usable.
     *
     * @returns `true` after `create` and before `dispose`; `false` otherwise.
     * @example
     * ```ts
     * if (td.isAlive()) { console.log(td.getContent()); }
     * ```
     */
    isAlive(): boolean {
        return this.alive;
    }
}
