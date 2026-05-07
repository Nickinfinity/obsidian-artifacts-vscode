import * as vscode from 'vscode';
import { parseFromContent, resolveVars, extractVars } from '../../services/parser.service.js';
import { renderCodeHtml, renderCodeRowsHtml } from '../../services/render.service.js';
import { patchFrontmatterField, patchVarDefaults } from '../../services/artifact-patcher.service.js';
import { PreviewModeController } from '../../services/preview-mode.service.js';
import { getNonce } from '../../utils/helpers.js';
import type { ParsedArtifactFile, ParsedBlock, ParsedVar } from '../../types/parsed-artifact.types.js';
import type { SectionKey } from '../../services/preview-mode.service.js';

/** QuickPick item with optional vault-specific metadata. */
interface ArtifactItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    isDirectory?: boolean;
    isBack?: boolean;
    /** Set when this item represents a `##`-headed block inside a multi-block file. */
    block?: ParsedBlock;
}

const POPUP_VIEW_TYPE     = 'obsidianArtifactPopupPreview';
const PREVIEW_DEBOUNCE_MS = 120;

const out = vscode.window.createOutputChannel('Obsidian Artifacts');

/**
 * Opens a QuickPick navigator for the given vault artifact directory.
 *
 * While the user navigates, a popup WebviewPanel beside the editor shows parsed
 * metadata + code + variable defaults (read-only preview mode).
 * When the user presses Enter on a file, the QuickPick closes, the popup switches
 * to interactive edit mode (editable variable inputs + Insert button), and the
 * extension waits for the user to confirm or cancel inside the panel.
 *
 * @param artifactDir  - Vault-relative directory name (e.g. `'Snippets'`).
 * @param artifactName - Human-readable name shown in the QuickPick title.
 * @param extensionUri - Extension URI used to resolve the shared CSS stylesheet.
 */
export async function openArtifactPicker(
    artifactDir: string,
    artifactName: string,
    extensionUri: vscode.Uri
): Promise<void> {
    const vaultPath = vscode.workspace
        .getConfiguration('obsidianArtifacts')
        .get<string>('vaultPath', '')
        .trim();

    if (!vaultPath) {
        vscode.window.showErrorMessage('Obsidian Artifacts: No vault configured. Open Settings to select your vault.');
        return;
    }

    const rootUri = vscode.Uri.joinPath(vscode.Uri.file(vaultPath), artifactDir);

    try {
        const stat = await vscode.workspace.fs.stat(rootUri);
        if ((stat.type & vscode.FileType.Directory) === 0) { throw new Error('not a directory'); }
    } catch {
        vscode.window.showErrorMessage(`Obsidian Artifacts: Directory "${artifactDir}" not found in your vault.`);
        return;
    }

    const targetEditor = vscode.window.activeTextEditor;
    await new ArtifactNavigator(rootUri, artifactName, targetEditor, extensionUri).run();
}

// ── ArtifactNavigator ─────────────────────────────────────────────────────────

class ArtifactNavigator {
    private readonly qp: vscode.QuickPick<ArtifactItem>;
    private readonly rootUri: vscode.Uri;
    private readonly artifactName: string;
    private readonly targetEditor: vscode.TextEditor | undefined;
    private readonly extensionUri: vscode.Uri;
    private readonly parseCache = new Map<string, ParsedArtifactFile>();
    private readonly refreshedUris = new Set<string>();

    private currentDir: vscode.Uri;
    private readonly dirStack: vscode.Uri[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** The artifact whose blocks are currently listed; set by `loadBlocks`. */
    private currentArtifact: ParsedArtifactFile | undefined;

    // The popup panel serves two roles:
    // • preview mode  — read-only metadata display while navigating
    // • edit mode     — interactive variable inputs + Insert button after file selection
    private popupPanel: vscode.WebviewPanel | undefined;

    // When true, onDidHide will NOT dispose the popup (because handleAccept will
    // keep it alive and switch it to edit mode).
    private keepPopupOnHide = false;

    private lastPreviewedUri = '';

    // Resolved webview URIs for the shared stylesheet — computed once when the
    // popup panel is first created, then reused for every subsequent HTML render.
    private cssUri    = '';
    private cspSource = '';

    // ── Preview panel interactive state ───────────────────────────────────────
    private currentPreviewArtifact: ParsedArtifactFile | undefined;
    private modeController: PreviewModeController | undefined;
    /** Subscription for the preview panel's `onDidReceiveMessage`; replaced on each new artifact. */
    private previewMsgSub: vscode.Disposable | undefined;
    /** Active subscriptions for fullEdit file watchers; cleared by `tearDownFullEdit`. */
    private fullEditSubs: vscode.Disposable[] = [];
    private fullEditDebounce: ReturnType<typeof setTimeout> | undefined;

    constructor(
        rootUri: vscode.Uri,
        artifactName: string,
        targetEditor: vscode.TextEditor | undefined,
        extensionUri: vscode.Uri
    ) {
        this.rootUri      = rootUri;
        this.currentDir   = rootUri;
        this.artifactName = artifactName;
        this.targetEditor = targetEditor;
        this.extensionUri = extensionUri;

        this.qp = vscode.window.createQuickPick<ArtifactItem>();
        this.qp.placeholder        = 'Type to filter — Enter to select and edit variables';
        this.qp.ignoreFocusOut     = true;
        this.qp.matchOnDescription = true;
        this.qp.matchOnDetail      = true;
    }

    async run(): Promise<void> {
        out.appendLine(`\n=== picker: ${this.artifactName}  root=${this.rootUri.fsPath} ===`);

        this.qp.onDidChangeActive(items => {
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            this.debounceTimer = setTimeout(() => void this.handleActiveChange(items), PREVIEW_DEBOUNCE_MS);
        });

        this.qp.onDidAccept(() => void this.handleAccept());

        this.qp.onDidHide(() => {
            if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
            // Only dispose the popup when the user dismissed the picker (Escape /
            // click-outside). If handleAccept set keepPopupOnHide = true it means
            // the popup is being handed off to edit mode — leave it alive.
            if (!this.keepPopupOnHide) {
                this.popupPanel?.dispose();
            }
            this.qp.dispose();
        });

        await this.loadDir(this.rootUri);
        this.qp.show();
    }

    // ── Directory loading ─────────────────────────────────────────────────────

    private async loadDir(uri: vscode.Uri): Promise<void> {
        this.currentDir = uri;
        this.qp.busy    = true;
        this.qp.value   = '';
        this.refreshedUris.clear();
        this.lastPreviewedUri = '';

        const rel     = this.relPath(uri);
        this.qp.title = rel ? `${this.artifactName} / ${rel}` : this.artifactName;

        const items: ArtifactItem[] = [];

        if (this.dirStack.length > 0) {
            items.push({ label: '$(arrow-left)  ..', description: 'Go back', isBack: true });
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            entries.sort(([nameA, typeA], [nameB, typeB]) => {
                const aIsDir = (typeA & vscode.FileType.Directory) !== 0;
                const bIsDir = (typeB & vscode.FileType.Directory) !== 0;
                if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
                return nameA.localeCompare(nameB);
            });

            for (const [name, fileType] of entries) {
                const isDir = (fileType & vscode.FileType.Directory) !== 0;
                if (!isDir && !name.endsWith('.md')) { continue; }
                const itemUri  = vscode.Uri.joinPath(uri, name);
                const fallback = isDir ? name : name.slice(0, -3);
                const cached   = isDir ? undefined : this.parseCache.get(itemUri.toString());
                items.push(buildItem(itemUri, isDir, fallback, cached, this.rootUri.fsPath));
                if (cached) { this.refreshedUris.add(itemUri.toString()); }
            }
        } catch (err) {
            out.appendLine(`[dir] read failed: ${(err as Error).message}`);
        }

        this.qp.items = items;
        this.qp.busy  = false;

        // Parse all file items in the background so metadata appears immediately.
        this.prefetchItems(items);

        // Trigger initial preview — onDidChangeActive may not fire automatically
        // when the QuickPick first shows.
        setTimeout(() => {
            const [first] = this.qp.activeItems;
            if (first) { void this.handleActiveChange([first]); }
        }, 60);
    }

    // ── Block listing ─────────────────────────────────────────────────────────

    /**
     * Replaces the QuickPick list with one item per parsed block in a multi-block file.
     *
     * Pushes `currentDir` onto `dirStack` first so the `..` back item navigates
     * correctly back to the parent directory listing.
     *
     * @param artifact - The multi-block artifact whose blocks are listed.
     *
     * @example
     * // Called after the user presses Enter on a file with blocks.length > 1.
     * this.loadBlocks(artifact);
     */
    private loadBlocks(artifact: ParsedArtifactFile): void {
        this.dirStack.push(this.currentDir);
        this.currentArtifact = artifact;
        this.qp.value = '';
        this.qp.title = artifact.frontmatter.title || artifact.fileName;

        const items: ArtifactItem[] = [];
        items.push({ label: '$(arrow-left)  ..', description: 'Go back', isBack: true });

        for (const block of artifact.blocks) {
            // ── Description: first sentence of block.description ──────────────
            const firstSentence = block.description
                ? (/^[^.!?]*[.!?]?/.exec(block.description)?.[0] ?? block.description).trim()
                : '';

            // ── Detail: vars summary (names only, no defaults) ────────────────
            const detail = block.vars.length > 0
                ? `$(symbol-variable)  ${block.vars.map(v => v.name.startsWith('VK-') ? v.name.slice(3) : v.name).join('  |  ')}`
                : undefined;

            items.push({ label: `$(code)  ${block.heading}`, description: firstSentence || undefined, detail, block });
        }

        this.qp.items = items;
        out.appendLine(`[blocks] listed ${artifact.blocks.length} blocks for "${this.qp.title}"`);
    }

    // ── Background prefetch ───────────────────────────────────────────────────

    /**
     * Parses all uncached `.md` items in parallel and refreshes their QuickPick
     * rows as each parse completes — so metadata is visible without the user
     * needing to navigate to each item first.
     *
     * @param items - The full item list for the current directory.
     */
    private prefetchItems(items: ArtifactItem[]): void {
        void Promise.all(
            items
                .filter(i => !i.isDirectory && !i.isBack && i.uri && !this.parseCache.has(i.uri.toString()))
                .map(async i => {
                    const artifact = await this.getOrParse(i.uri!);
                    if (artifact) { this.refreshItem(i.uri!, artifact); }
                })
        );
    }

    // ── Active change → preview mode ──────────────────────────────────────────

    private async handleActiveChange(items: readonly ArtifactItem[]): Promise<void> {
        const item = items[0];
        out.appendLine(`[active] "${item?.label ?? ''}" isDir=${item?.isDirectory} uri=${item?.uri?.fsPath ?? ''} block=${item?.block?.heading ?? ''}`);

        // ── Block item: preview the individual block ──────────────────────────
        if (item?.block && this.currentArtifact) {
            const key = `block:${item.block.heading}`;
            if (key !== this.lastPreviewedUri) {
                this.lastPreviewedUri = key;
                await this.showPreviewPanel(blockAsArtifact(item.block, this.currentArtifact));
            }
            return;
        }

        if (!item || item.isBack || item.isDirectory || !item.uri) {
            if (this.popupPanel) {
                this.popupPanel.webview.html = renderPopupEmptyHtml(this.cssUri, this.cspSource);
            }
            return;
        }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) { return; }

        this.refreshItem(item.uri, artifact);

        const key = item.uri.toString();
        if (key === this.lastPreviewedUri) { return; }
        this.lastPreviewedUri = key;

        // ── Multi-block file: render all blocks stacked ───────────────────────
        if (artifact.blocks.length > 1) {
            await this.showMultiBlockPreviewPanel(artifact);
            return;
        }

        await this.showPreviewPanel(artifact);
    }

    // ── Popup: multi-block preview ────────────────────────────────────────────

    /**
     * Creates or updates the popup panel with a stacked multi-block preview.
     *
     * Highlights all blocks in parallel, then renders them with
     * `renderMultiBlockPreviewHtml`. Each block gets its own `<h2>`, description,
     * highlighted code, and compact vars row.
     *
     * @param artifact - Multi-block artifact to preview.
     *
     * @example
     * await this.showMultiBlockPreviewPanel(artifact);
     */
    private async showMultiBlockPreviewPanel(artifact: ParsedArtifactFile): Promise<void> {
        if (!this.popupPanel) {
            try {
                this.popupPanel = vscode.window.createWebviewPanel(
                    POPUP_VIEW_TYPE,
                    'Artifact Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'ui')],
                    }
                );
                this.popupPanel.onDidDispose(() => { this.popupPanel = undefined; });
                this.cssUri    = this.popupPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'styles.css')
                ).toString();
                this.cspSource = this.popupPanel.webview.cspSource;
            } catch (err) {
                out.appendLine(`[popup] create FAILED (multi-block): ${(err as Error).message}`);
                return;
            }
        }

        const highlightedBlocks = artifact.blocks.map(b => ({
            heading:     b.heading,
            codeHtml:    renderCodeHtml(b.code, b.fenceLang ?? artifact.frontmatter.language),
            vars:        b.vars,
            description: b.description,
        }));

        this.popupPanel.webview.html = renderMultiBlockPreviewHtml(artifact, highlightedBlocks, this.cssUri, this.cspSource);
        this.popupPanel.reveal(this.popupPanel.viewColumn, true /* preserveFocus */);
        out.appendLine(`[popup] multi-block preview → ${artifact.fileName} (${artifact.blocks.length} blocks)`);
    }

    // ── Parsing & cache ───────────────────────────────────────────────────────

    private async getOrParse(uri: vscode.Uri): Promise<ParsedArtifactFile | undefined> {
        const key = uri.toString();
        const hit = this.parseCache.get(key);
        if (hit) { out.appendLine(`[parse] cache hit ${uri.fsPath}`); return hit; }
        try {
            const bytes   = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(bytes);
            const parsed  = parseFromContent(content, uri.fsPath, this.rootUri.fsPath);
            this.parseCache.set(key, parsed);
            out.appendLine(`[parse] OK "${parsed.frontmatter.title ?? parsed.fileName}" vars=${parsed.vars.length}`);
            return parsed;
        } catch (err) {
            out.appendLine(`[parse] FAILED ${uri.fsPath}: ${(err as Error).message}`);
            return undefined;
        }
    }

    // ── QuickPick item refresh ────────────────────────────────────────────────

    private refreshItem(uri: vscode.Uri, artifact: ParsedArtifactFile): void {
        const key = uri.toString();
        if (this.refreshedUris.has(key)) { return; }
        this.refreshedUris.add(key);
        this.qp.items = this.qp.items.map(i =>
            i.uri?.toString() === key
                ? buildItem(uri, false, artifact.fileName, artifact, this.rootUri.fsPath)
                : i
        );
        // No qp.activeItems restore — avoids the onDidChangeActive re-fire loop.
    }

    // ── Popup: preview mode ───────────────────────────────────────────────────

    /**
     * Creates (once per session) or updates the popup panel in read-only preview mode.
     *
     * `createWebviewPanel` alone does not make the panel visible — `reveal()` is required.
     * `reveal(column, preserveFocus=true)` brings the column into view while keeping
     * keyboard focus on the QuickPick so the user can keep navigating with arrow keys.
     */
    private async showPreviewPanel(artifact: ParsedArtifactFile): Promise<void> {
        // Tear down any active fullEdit watchers before switching to a new artifact.
        this.tearDownFullEdit();
        this.currentPreviewArtifact = artifact;
        this.modeController         = new PreviewModeController(artifact.code);

        if (!this.popupPanel) {
            try {
                this.popupPanel = vscode.window.createWebviewPanel(
                    POPUP_VIEW_TYPE,
                    'Artifact Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'ui')],
                    }
                );
                this.popupPanel.onDidDispose(() => {
                    this.tearDownFullEdit();
                    this.previewMsgSub?.dispose();
                    this.previewMsgSub = undefined;
                    this.popupPanel    = undefined;
                });
                // Resolve CSS URI once — reused for all subsequent renders.
                this.cssUri    = this.popupPanel.webview.asWebviewUri(
                    vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'styles.css')
                ).toString();
                this.cspSource = this.popupPanel.webview.cspSource;
                out.appendLine(`[popup] created`);
            } catch (err) {
                out.appendLine(`[popup] create FAILED: ${(err as Error).message}`);
                return;
            }
        }
        const codeRowsHtml = renderCodeRowsHtml(artifact.code, artifact.frontmatter.language);
        this.popupPanel.webview.html = renderPreviewHtml(artifact, codeRowsHtml, getNonce(), this.cssUri, this.cspSource);
        this.setupPreviewMessageHandler();
        // reveal() is what makes the panel tab visible in its column.
        this.popupPanel.reveal(this.popupPanel.viewColumn, true /* preserveFocus */);
        out.appendLine(`[popup] preview → ${artifact.fileName}`);
    }

    // ── Accept handler ────────────────────────────────────────────────────────

    private async handleAccept(): Promise<void> {
        const [item] = this.qp.activeItems;
        if (!item) { return; }

        if (item.isBack) {
            const prev = this.dirStack.pop();
            if (prev) { await this.loadDir(prev); }
            return;
        }

        if (item.isDirectory && item.uri) {
            this.dirStack.push(this.currentDir);
            await this.loadDir(item.uri);
            return;
        }

        // ── Block item accepted: keep preview panel, focus it for interaction ─
        if (item.block && this.currentArtifact) {
            const blockArtifact = blockAsArtifact(item.block, this.currentArtifact);
            this.keepPopupOnHide = true;
            this.qp.hide();
            await this.showPreviewPanel(blockArtifact);
            this.popupPanel?.reveal(this.popupPanel.viewColumn ?? vscode.ViewColumn.Beside, false);
            return;
        }

        if (!item.uri) { return; }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) {
            vscode.window.showErrorMessage('Obsidian Artifacts: Could not read file.');
            return;
        }

        // ── Multi-block file: show block list instead of edit mode ────────────
        if (artifact.blocks.length > 1) {
            this.loadBlocks(artifact);
            return;
        }

        // ── Single-block file: keep preview panel as the interaction surface ──
        this.keepPopupOnHide = true;
        this.qp.hide();
        await this.showPreviewPanel(artifact);
        this.popupPanel?.reveal(this.popupPanel.viewColumn ?? vscode.ViewColumn.Beside, false);
    }

    // ── Preview panel message handling ───────────────────────────────────────

    /**
     * Registers (or re-registers) a `onDidReceiveMessage` listener on the current
     * popup panel.  Disposes the previous subscription first so navigation between
     * artifacts never accumulates stale listeners.
     *
     * @example
     * this.setupPreviewMessageHandler();
     */
    private setupPreviewMessageHandler(): void {
        this.previewMsgSub?.dispose();
        this.previewMsgSub = undefined;
        if (!this.popupPanel) { return; }
        this.previewMsgSub = this.popupPanel.webview.onDidReceiveMessage(msg => {
            void this.handlePreviewMessage(msg as Record<string, unknown>);
        });
    }

    /**
     * Dispatches a single message from the preview webview to the correct handler.
     *
     * @param msg - Raw message object from `onDidReceiveMessage`.
     *
     * @example
     * await this.handlePreviewMessage({ command: 'insert', vars: {}, code: '...' });
     */
    private async handlePreviewMessage(msg: Record<string, unknown>): Promise<void> {
        const cmd = msg.command as string;
        if      (cmd === 'startEdit')     { this.modeController?.startEditingSection(msg.section as SectionKey); }
        else if (cmd === 'cancelEdit')    { this.modeController?.stopEditingSection(msg.section as SectionKey); }
        else if (cmd === 'quickEdit')     { this.modeController?.enterQuickEdit(); }
        else if (cmd === 'backToPreview') { this.modeController?.enterPreview(); }
        else if (cmd === 'fullEdit')      { this.handleFullEdit(); }
        else if (cmd === 'saveSection')   { await this.handleSaveSection(msg); }
        else if (cmd === 'insert')        { this.handleInsert(msg); }
        else if (cmd === 'cancel')        { this.popupPanel?.dispose(); }
    }

    /**
     * Reads, patches, and writes the current artifact file for a `saveSection` message.
     * Posts `sectionSaved` (success/failure) and, on success, `fileUpdated` to the webview.
     *
     * @param msg - The raw `saveSection` message.
     *
     * @example
     * await this.handleSaveSection({ command: 'saveSection', section: 'title', value: 'New' });
     */
    private async handleSaveSection(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.currentPreviewArtifact;
        if (!artifact) { return; }
        const fileUri = vscode.Uri.file(artifact.filePath);
        const section = msg.section as string;
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            let content = new TextDecoder().decode(bytes);
            if (section === 'varDefaults') {
                content = patchVarDefaults(content, msg.value as Record<string, string>);
            } else {
                content = patchFrontmatterField(content, section, msg.value as string);
            }
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
            const updated = parseFromContent(content, fileUri.fsPath, this.rootUri.fsPath);
            this.parseCache.set(fileUri.toString(), updated);
            this.currentPreviewArtifact = updated;
            this.modeController?.stopEditingSection(section as SectionKey);
            // sectionSaved before fileUpdated so the webview exits edit mode first,
            // then fileUpdated can safely update all non-editing sections.
            void this.popupPanel?.webview.postMessage({ command: 'sectionSaved', section, success: true });
            void this.popupPanel?.webview.postMessage({ command: 'fileUpdated', artifact: updated });
        } catch {
            void this.popupPanel?.webview.postMessage({ command: 'sectionSaved', section, success: false });
        }
    }

    /**
     * Opens the artifact's real `.md` file in an editor tab and sets up watchers
     * for `onDidSaveTextDocument` (→ `fileUpdated`) and `onDidChangeTextDocument`
     * debounced 500 ms (→ `updateVars`).
     *
     * @example
     * this.handleFullEdit();
     */
    private handleFullEdit(): void {
        const artifact = this.currentPreviewArtifact;
        if (!artifact) { return; }
        this.modeController?.enterFullEdit();
        const fileUri = vscode.Uri.file(artifact.filePath);
        void vscode.window.showTextDocument(fileUri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
        this.setupFullEdit(fileUri);
    }

    /**
     * Performs insert using the current artifact code (or edited code for quickEdit /
     * fullEdit modes), then closes the picker and panel.
     *
     * @param msg - The raw `insert` message, optionally carrying an inline `code` string.
     *
     * @example
     * this.handleInsert({ command: 'insert', vars: { 'VK-x': '1' }, code: 'const x = 1;' });
     */
    private handleInsert(msg: Record<string, unknown>): void {
        const artifact = this.currentPreviewArtifact;
        if (!artifact) { return; }
        const mode = this.modeController?.mode ?? 'preview';
        // fullEdit: prefer the live .md document content (canonical, possibly edited externally).
        // preview/quickEdit: prefer msg.code from the contenteditable webview surface.
        let code = artifact.code;
        if (mode === 'fullEdit') {
            const fileUri = vscode.Uri.file(artifact.filePath);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
            if (openDoc) {
                code = parseFromContent(openDoc.getText(), artifact.filePath, this.rootUri.fsPath).code;
            } else if (typeof msg.code === 'string') {
                code = msg.code;
            }
        } else if (typeof msg.code === 'string') {
            code = msg.code;
        }
        // ── Merge collected values with artifact defaults ──────────────────────
        // Empty collected value → fall back to defaultValue.
        // Both empty → omit key so resolveVars leaves the <VK-xxx> token intact.
        const rawVars = msg.vars as Record<string, string>;
        const resolvedVars: Record<string, string> = {};
        for (const v of artifact.vars) {
            const collected = rawVars[v.name] ?? '';
            const effective = collected || v.defaultValue;
            if (effective) { resolvedVars[v.name] = effective; }
        }

        performInsert(this.targetEditor, { ...artifact, code }, resolvedVars);
        this.tearDownFullEdit();
        this.popupPanel?.dispose();
        this.qp.hide();
    }

    // ── fullEdit file watchers ────────────────────────────────────────────────

    /**
     * Subscribes to document save and change events for the given file URI.
     * Replaces any previously active fullEdit subscriptions.
     *
     * @param fileUri - The real artifact file being edited.
     *
     * @example
     * this.setupFullEdit(vscode.Uri.file(artifact.filePath));
     */
    private setupFullEdit(fileUri: vscode.Uri): void {
        this.tearDownFullEdit();
        const uriKey = fileUri.toString();
        this.fullEditSubs.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.toString() !== uriKey) { return; }
                void this.onFullEditSave(doc.getText(), fileUri);
            }),
            vscode.workspace.onDidChangeTextDocument(change => {
                if (change.document.uri.toString() !== uriKey) { return; }
                if (this.fullEditDebounce) { clearTimeout(this.fullEditDebounce); }
                this.fullEditDebounce = setTimeout(() => this.flushFullEditVarSync(change.document), 500);
            }),
        );
    }

    /**
     * Sends an `updateVars` message to the webview after the 500 ms debounce fires.
     *
     * @param doc - The document that changed (the real artifact file).
     *
     * @example
     * this.flushFullEditVarSync(document);
     */
    private flushFullEditVarSync(doc: vscode.TextDocument): void {
        this.fullEditDebounce = undefined;
        const vars = extractVars(doc.getText());
        void this.popupPanel?.webview.postMessage({ command: 'updateVars', vars });
    }

    /**
     * Re-parses the artifact file content after a save and posts `fileUpdated`.
     *
     * @param content - Raw file content string (already read by the caller).
     * @param fileUri - URI of the artifact file.
     *
     * @example
     * await this.onFullEditSave(doc.getText(), fileUri);
     */
    private async onFullEditSave(content: string, fileUri: vscode.Uri): Promise<void> {
        const artifact = this.currentPreviewArtifact;
        if (!artifact) { return; }
        const updated = parseFromContent(content, fileUri.fsPath, this.rootUri.fsPath);
        this.parseCache.set(fileUri.toString(), updated);
        this.currentPreviewArtifact = updated;
        void this.popupPanel?.webview.postMessage({ command: 'fileUpdated', artifact: updated });
    }

    /**
     * Disposes all active fullEdit subscriptions and cancels any pending debounce timer.
     * Safe to call multiple times.
     *
     * @example
     * this.tearDownFullEdit();
     */
    private tearDownFullEdit(): void {
        this.fullEditSubs.forEach(s => s.dispose());
        this.fullEditSubs = [];
        if (this.fullEditDebounce) { clearTimeout(this.fullEditDebounce); this.fullEditDebounce = undefined; }
    }

    private relPath(uri: vscode.Uri): string {
        const root = this.rootUri.fsPath;
        const p    = uri.fsPath;
        if (p === root) { return ''; }
        return p.startsWith(root) ? p.slice(root.length + 1).replaceAll('\\', ' / ') : '';
    }
}

// ── Block adapter ─────────────────────────────────────────────────────────────

/**
 * Adapts a `ParsedBlock` into a minimal `ParsedArtifactFile` so it can be passed
 * to `renderPreviewHtml`, `renderEditHtml`, and `performInsert` without changes
 * to those functions.
 *
 * Inherits `frontmatter`, `filePath`, `fileName`, and `relativePath` from the
 * parent artifact; overrides `title`, `description`, `language`, `code`, `vars`,
 * and clears `blocks` (blocks never nest).
 *
 * @param block  - The block to adapt.
 * @param parent - The artifact the block belongs to.
 * @returns A `ParsedArtifactFile`-shaped object for the block.
 *
 * @example
 * const adapted = blockAsArtifact(item.block, this.currentArtifact);
 * await this.showPreviewPanel(adapted);
 */
function blockAsArtifact(block: ParsedBlock, parent: ParsedArtifactFile): ParsedArtifactFile {
    return {
        ...parent,
        frontmatter: {
            ...parent.frontmatter,
            title:       block.heading,
            description: block.description || undefined,
            language:    block.fenceLang ?? parent.frontmatter.language,
        },
        code:   block.code,
        vars:   block.vars,
        blocks: [],
    };
}

// ── QuickPick item builder ────────────────────────────────────────────────────

/**
 * Builds a richly populated `ArtifactItem`.
 *
 * - `label`       — `$(file)  <title>` (filename fallback).
 * - `description` — Parsed description (relative-path fallback when absent).
 * - `detail`      — `$(symbol-variable) key=val | key=val    $(tag) #tag1 #tag2` (omitted when both empty).
 *
 * @param uri      - File or directory URI.
 * @param isDir    - True when the entry is a directory.
 * @param fallback - Display name to use before the file is parsed.
 * @param parsed   - Parsed metadata, or `undefined` if not yet loaded.
 * @param rootFs   - Absolute filesystem path of the artifact root directory.
 *
 * @example
 * buildItem(uri, false, 'express-route', parsed, '/vault/Snippets')
 */
function buildItem(
    uri: vscode.Uri,
    isDir: boolean,
    fallback: string,
    parsed: ParsedArtifactFile | undefined,
    rootFs: string
): ArtifactItem {
    if (isDir) {
        return { label: `$(folder)  ${fallback}`, uri, isDirectory: true };
    }

    const title       = parsed?.frontmatter.title || fallback;
    const description = parsed?.frontmatter.description || relFsPath(uri, rootFs);

    // ── detail: vars then tags, each section prefixed with a codicon ─────────
    const varsPart = parsed?.vars.length
        ? `$(symbol-variable)  ${parsed.vars.map(v => (v.name.startsWith('VK-') ? v.name.slice(3) : v.name) + (v.defaultValue ? '=' + v.defaultValue : '')).join('  |  ')}`
        : '';
    const tagsPart = parsed?.frontmatter.tags?.length
        ? `$(tag)  ${parsed.frontmatter.tags.map(t => '#' + t).join(' ')}`
        : '';
    const detail = varsPart || tagsPart
        ? [varsPart, tagsPart].filter(Boolean).join('    ')
        : undefined;

    return { label: `$(file)  ${title}`, description, detail, uri, isDirectory: false };
}

function relFsPath(uri: vscode.Uri, rootFs: string): string {
    const p = uri.fsPath;
    return (p.startsWith(rootFs + '/') || p.startsWith(rootFs + '\\'))
        ? p.slice(rootFs.length + 1).replaceAll('\\', '/')
        : p;
}

// ── Insert helpers ────────────────────────────────────────────────────────────

/**
 * Substitutes variables and delivers resolved content to the editor, terminal, or clipboard.
 *
 * For `type: command` artifacts the resolved text is sent to the active terminal (created
 * if absent). For all other types the text is inserted at the cursor; if no editor is open
 * it falls back to the clipboard with an informational message.
 *
 * @param editor   - Active text editor to insert into, or `undefined` when none is open.
 * @param artifact - Artifact supplying the code template and type.
 * @param vars     - Resolved `{ name → value }` map from the edit panel or input box.
 *
 * @example
 * performInsert(vscode.window.activeTextEditor, artifact, { 'VK-host': 'localhost' });
 */
function performInsert(
    editor: vscode.TextEditor | undefined,
    artifact: ParsedArtifactFile,
    vars: Record<string, string>
): void {
    const content = resolveVars(artifact.code, vars);
    if (artifact.frontmatter.type === 'command') {
        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Obsidian Artifacts');
        terminal.sendText(content, false);
        terminal.show(true);
        return;
    }
    if (editor) {
        editor.edit(edit => edit.insert(editor.selection.active, content));
        return;
    }
    vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage('Obsidian Artifacts: No active editor — content copied to clipboard.');
}

// ── Popup HTML: preview mode (read-only) ─────────────────────────────────────

/**
 * Renders the interactive artifact preview HTML.
 *
 * The code area is contenteditable — users can edit/paste, but edits are not
 * saved to the `.md` file. Variables are filled inline. Buttons:
 * - **Insert** posts current code + variable values to the extension.
 * - **Edit .md** opens the underlying `.md` file in a real editor (where save updates the file).
 * - **Cancel** disposes the panel.
 *
 * @param a         - Parsed artifact to display.
 * @param codeHtml  - Pre-rendered code HTML (from `renderCodeHtml`) — supplies initial content.
 * @param nonce     - CSP nonce for the inline script.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @param cspSource - Webview CSP source token (from `webview.cspSource`).
 *
 * @example
 * panel.webview.html = renderPreviewHtml(artifact, codeHtml, getNonce(), cssUri, cspSource);
 */
function renderPreviewHtml(
    a: ParsedArtifactFile,
    codeHtml: string,
    nonce: string,
    cssUri: string,
    cspSource: string
): string {
    const e = escHtml;
    const title    = e(a.frontmatter.title || a.fileName);
    const type     = e(a.frontmatter.type);
    const lang     = a.frontmatter.language ? e(a.frontmatter.language) : '';
    const desc     = a.frontmatter.description ? e(a.frontmatter.description) : '';
    const env      = a.frontmatter.env ? `<span class="pill">env: ${e(a.frontmatter.env)}</span>` : '';
    const target   = a.frontmatter.target ? `<span class="pill">target: ${e(a.frontmatter.target)}</span>` : '';
    const tagsHtml = (a.frontmatter.tags ?? []).map(t => `<span class="tag">${e(t)}</span>`).join('');

    const inputsHtml = a.vars.length > 0
        ? a.vars.map(v => `
             <div class="input-row">
               <label for="v-${e(v.name)}">${e(labelForVar(v.name))}</label>
               <input id="v-${e(v.name)}" data-var="${e(v.name)}" type="text"
                      value="${e(v.defaultValue)}" placeholder="${e(labelForVar(v.name))}">
             </div>`).join('')
        : '<p class="muted">No variables defined.</p>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body class="popup-body">
  <h1>${title}</h1>
  <div class="badges">
    <span class="badge">${type}</span>
    ${lang ? `<span class="badge lang">${lang}</span>` : ''}
    ${env}${target}
  </div>
  ${desc ? `<p class="desc">${desc}</p>` : ''}
  ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
  <div class="slabel">Content <span class="slabel-hint">— editable, not saved to .md</span></div>
  <div id="codeWrapper" class="code-block-wrapper editable" contenteditable="true" spellcheck="false" data-lang="${lang}">${codeHtml || ''}</div>
  <div class="slabel">Variables</div>
  <div class="inputs" id="varInputs">${inputsHtml}</div>
  <div class="actions">
    <button class="btn btn-insert"    id="insertBtn">Insert</button>
    <button class="btn btn-secondary" id="editBtn">Edit .md</button>
    <button class="btn btn-cancel"    id="cancelBtn">Cancel</button>
  </div>
  <p class="path">${e(a.relativePath)}</p>
<script nonce="${nonce}">
(function () {
  const vscode      = acquireVsCodeApi();
  const codeWrapper = document.getElementById('codeWrapper');
  const varInputs   = document.getElementById('varInputs');

  // ── Plain-text extraction ─────────────────────────────────────────────────
  function extractCode() {
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    if (rows.length === 0) { return codeWrapper.textContent || ''; }
    const parts = [];
    rows.forEach(r => {
      const c = r.querySelector('.code-content');
      parts.push(c ? c.textContent : '');
    });
    return parts.join('\\n');
  }

  // ── Render: line numbers + escape + VK highlight ─────────────────────────
  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function vkWrap(html) {
    return html.replace(/&lt;VK-([A-Za-z]\\w*)&gt;/g, '<span class="vk-var">&lt;VK-$1&gt;</span>');
  }
  function renderRows(code) {
    const lines = code.split('\\n');
    return lines.map(function (line, i) {
      return '<div class="code-line-row"><span class="line-number" contenteditable="false">' +
        (i + 1) + '</span><span class="code-content">' + vkWrap(escHtml(line)) + '</span></div>';
    }).join('');
  }

  // ── Caret offset (counted across all .code-content text + joining \\n) ───
  function getCaretOffset() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return 0; }
    const range = sel.getRangeAt(0);
    if (!codeWrapper.contains(range.endContainer)) { return 0; }
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    let offset = 0;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].querySelector('.code-content');
      if (!c) { continue; }
      if (c.contains(range.endContainer) || c === range.endContainer) {
        const pre = document.createRange();
        pre.selectNodeContents(c);
        pre.setEnd(range.endContainer, range.endOffset);
        return offset + pre.toString().length;
      }
      offset += c.textContent.length + 1;
    }
    return offset;
  }
  function setCaretOffset(offset) {
    const rows = codeWrapper.querySelectorAll('.code-line-row');
    let remaining = offset;
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i].querySelector('.code-content');
      if (!c) { continue; }
      const len = c.textContent.length;
      if (remaining <= len) { placeCaret(c, remaining); return; }
      remaining -= len + 1;
    }
    const last = rows[rows.length - 1] && rows[rows.length - 1].querySelector('.code-content');
    if (last) { placeCaret(last, last.textContent.length); }
  }
  function placeCaret(el, off) {
    let remaining = off, target = null, targetOffset = 0;
    (function walk(node) {
      if (target) { return; }
      if (node.nodeType === 3 /* TEXT_NODE */) {
        if (remaining <= node.length) { target = node; targetOffset = remaining; }
        else { remaining -= node.length; }
        return;
      }
      for (let i = 0; i < node.childNodes.length && !target; i++) { walk(node.childNodes[i]); }
    })(el);
    const range = document.createRange();
    if (target) { range.setStart(target, targetOffset); range.collapse(true); }
    else        { range.selectNodeContents(el); range.collapse(false); }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Re-render on input (debounced) ───────────────────────────────────────
  let renderTimer;
  function scheduleRender() {
    if (renderTimer) { clearTimeout(renderTimer); }
    renderTimer = setTimeout(function () {
      renderTimer = undefined;
      const code  = extractCode();
      const caret = getCaretOffset();
      codeWrapper.innerHTML = renderRows(code);
      setCaretOffset(caret);
    }, 150);
  }
  codeWrapper.addEventListener('input', scheduleRender);
  codeWrapper.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      document.execCommand('insertText', false, '\\n');
    }
  });
  codeWrapper.addEventListener('paste', function (ev) {
    ev.preventDefault();
    const text = (ev.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // ── Buttons ──────────────────────────────────────────────────────────────
  function collectVars() {
    const out = {};
    document.querySelectorAll('[data-var]').forEach(function (el) { out[el.dataset.var] = el.value; });
    return out;
  }
  document.getElementById('insertBtn').addEventListener('click', function () {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = undefined; }
    vscode.postMessage({ command: 'insert', vars: collectVars(), code: extractCode() });
  });
  document.getElementById('editBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'fullEdit' });
  });
  document.getElementById('cancelBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'cancel' });
  });
  // Ctrl/Cmd+Enter inserts.
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      document.getElementById('insertBtn').click();
    }
  });

  // ── Update var inputs on extension push (live VK detection) ──────────────
  function rebuildVarInputs(vars) {
    const existing = collectVars();
    if (!vars || vars.length === 0) {
      varInputs.innerHTML = '<p class="muted">No variables defined.</p>';
      return;
    }
    function lbl(name) {
      const hint = name.indexOf('VK-') === 0 ? name.slice(3) : name;
      const j    = hint.split('_').join(' ').toLowerCase();
      return j.charAt(0).toUpperCase() + j.slice(1);
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    varInputs.innerHTML = vars.map(function (v) {
      const value = existing[v.name] !== undefined ? existing[v.name] : (v.defaultValue || '');
      return '<div class="input-row">' +
        '<label for="v-' + esc(v.name) + '">' + esc(lbl(v.name)) + '</label>' +
        '<input id="v-' + esc(v.name) + '" data-var="' + esc(v.name) + '" type="text" value="' + esc(value) + '" placeholder="' + esc(lbl(v.name)) + '">' +
      '</div>';
    }).join('');
  }
  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.command === 'updateVars')  { rebuildVarInputs(msg.vars); }
    if (msg.command === 'fileUpdated' && msg.artifact) {
      // Refresh code area to canonical .md content (Edit-mode save round-trip).
      codeWrapper.innerHTML = renderRows(msg.artifact.code || '');
      rebuildVarInputs(msg.artifact.vars);
    }
  });
})();
</script>
</body>
</html>`;
}

// ── Popup HTML: multi-block preview (read-only) ───────────────────────────────

/**
 * Renders a stacked read-only preview of all blocks in a multi-block artifact.
 *
 * Each block is rendered as: `<h2>` heading, optional description `<p>`,
 * highlighted code, and a compact inline vars row. File-level metadata
 * (type badge, tags, path) appears once at the top.
 *
 * @param a                - The parent artifact (supplies frontmatter + relativePath).
 * @param highlightedBlocks - Pre-highlighted block data (heading, codeHtml, vars, description).
 * @param cssUri           - Webview URI for the shared stylesheet.
 * @param cspSource        - Webview CSP source token (from `webview.cspSource`).
 *
 * @example
 * panel.webview.html = renderMultiBlockPreviewHtml(artifact, highlightedBlocks, cssUri, cspSource);
 */
function renderMultiBlockPreviewHtml(
    a: ParsedArtifactFile,
    highlightedBlocks: { heading: string; codeHtml: string; vars: ParsedVar[]; description: string }[],
    cssUri: string,
    cspSource: string
): string {
    const e = escHtml;
    const title    = e(a.frontmatter.title || a.fileName);
    const type     = e(a.frontmatter.type);
    const lang     = a.frontmatter.language ? e(a.frontmatter.language) : '';
    const tagsHtml = (a.frontmatter.tags ?? []).map(t => `<span class="tag">${e(t)}</span>`).join('');

    const blocksHtml = highlightedBlocks.map(b => {
        const varCodes = b.vars.map(v => `<code>${e(v.name)}</code>`).join(' · ');
        const varsRow  = b.vars.length > 0 ? `<p class="muted block-vars">${varCodes}</p>` : '';
        return /* html */`
    <h2 class="block-heading">${e(b.heading)}</h2>
    ${b.description ? `<p class="desc">${e(b.description)}</p>` : ''}
    ${b.codeHtml}
    ${varsRow}`;
    }).join('\n');

    return popupShell(/* html */`
    <h1>${title}</h1>
    <div class="badges">
      <span class="badge">${type}</span>
      ${lang ? `<span class="badge lang">${lang}</span>` : ''}
    </div>
    ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
    ${blocksHtml}
    <p class="path">${e(a.relativePath)}</p>
    <p class="hint">Press Enter to choose a block.</p>`,
    cssUri, cspSource);
}

// ── Popup HTML: empty state ───────────────────────────────────────────────────

function renderPopupEmptyHtml(cssUri: string, cspSource: string): string {
    return popupShell(
        '<p style="text-align:center;margin-top:40px">Select a file to preview</p>',
        cssUri,
        cspSource
    );
}

// ── Popup HTML shared shell ───────────────────────────────────────────────────

/**
 * Wraps popup body content in a complete HTML document that loads the shared stylesheet.
 *
 * @param body      - Inner HTML to place inside `<body>`.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @param cspSource - Webview CSP source token; falls back to `'unsafe-inline'` before
 *                    the panel is created (e.g. for the initial empty-state render).
 *
 * @example
 * return popupShell('<p>Hello</p>', cssUri, cspSource);
 */
function popupShell(body: string, cssUri: string, cspSource = "'unsafe-inline'"): string {
    const linkTag = cssUri ? `<link rel="stylesheet" href="${cssUri}">` : '';
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource};">
${linkTag}
</head>
<body class="popup-body">${body}</body>
</html>`;
}

function escHtml(s: string): string {
    return s.replaceAll(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Converts a `VK-xxx` variable name to a human-readable input label.
 *
 * Strips the `VK-` prefix, replaces `_` separators with spaces, lowercases
 * the result, then capitalises the first letter — used in the edit panel and
 * the `showInputBox` fallback.
 *
 * @param name - Full variable name including the `VK-` prefix.
 * @returns Human-readable label string.
 *
 * @example
 * labelForVar('VK-min_price')  // → 'Min price'
 * labelForVar('VK-MY_VAR')     // → 'My var'
 */
function labelForVar(name: string): string {
    const hint   = name.startsWith('VK-') ? name.slice(3) : name;
    const joined = hint.split('_').join(' ').toLowerCase();
    return joined.charAt(0).toUpperCase() + joined.slice(1);
}
