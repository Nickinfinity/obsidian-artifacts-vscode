import * as vscode from 'vscode';
import { parseFromContent, resolveVars } from '../../services/parser.service.js';
import { renderCodeHtml } from '../../services/render.service.js';
import { getNonce } from '../../utils/helpers.js';
import type { ParsedArtifactFile, ParsedBlock, ParsedVar } from '../../types/parsed-artifact.types.js';

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
                ? `$(symbol-variable)  ${block.vars.map(v => v.name).join('  |  ')}`
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
                        enableScripts: false,
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
        const codeHtml = renderCodeHtml(artifact.code, artifact.frontmatter.language);
        this.popupPanel.webview.html = renderPreviewHtml(artifact, codeHtml, this.cssUri, this.cspSource);
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

        // ── Block item accepted: go straight to edit mode for that block ─────
        if (item.block && this.currentArtifact) {
            this.keepPopupOnHide = true;
            this.qp.hide();
            await this.openEditMode(this.currentArtifact, item.block.code, item.block.vars);
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

        // ── File selected: switch popup to edit mode ───────────────────────────
        this.keepPopupOnHide = true;
        this.qp.hide();
        await this.openEditMode(artifact);
    }

    /**
     * Ensures the popup panel exists, renders it in interactive edit mode for
     * the given artifact, waits for Insert / Cancel, then performs the insert.
     *
     * `codeOverride` and `varsOverride` substitute the artifact's own `code` and
     * `vars` when rendering and inserting — used for block-item selections so the
     * block's content is shown while `artifact.frontmatter.type` still drives
     * command-vs-snippet routing in `performInsert`.
     *
     * @param artifact      - Artifact supplying frontmatter (type, title, language).
     * @param codeOverride  - Block code to show/insert instead of `artifact.code`.
     * @param varsOverride  - Block vars to show instead of `artifact.vars`.
     *
     * @example
     * await this.openEditMode(artifact);
     * await this.openEditMode(parent, block.code, block.vars);
     */
    private async openEditMode(artifact: ParsedArtifactFile, codeOverride?: string, varsOverride?: ParsedVar[]): Promise<void> {
        // Ensure the popup panel exists (the user might have pressed Enter before
        // the 120 ms debounce fired and created it).
        if (!this.popupPanel) {
            try {
                this.popupPanel = vscode.window.createWebviewPanel(
                    POPUP_VIEW_TYPE,
                    'Artifact Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
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
                out.appendLine(`[popup] create FAILED in accept: ${(err as Error).message}`);
                await this.insertWithInputBoxFallback(artifact);
                return;
            }
        }

        const code     = codeOverride ?? artifact.code;
        const editVars = varsOverride ?? artifact.vars;
        const editArtifact = (codeOverride !== undefined || varsOverride !== undefined)
            ? { ...artifact, code, vars: editVars }
            : artifact;

        const codeHtml = renderCodeHtml(code, artifact.frontmatter.language);

        this.popupPanel.webview.html = renderEditHtml(editArtifact, getNonce(), codeHtml, this.cssUri, this.cspSource);
        this.popupPanel.reveal(this.popupPanel.viewColumn, false /* take focus */);
        out.appendLine(`[popup] edit mode → ${artifact.fileName}`);

        const vars = await waitForEditMessage(this.popupPanel);
        this.popupPanel?.dispose();
        this.popupPanel = undefined;

        if (vars !== null) {
            performInsert(this.targetEditor, editArtifact, vars);
        }
    }

    /** Fallback when the popup can't be created — uses showInputBox (original behaviour). */
    private async insertWithInputBoxFallback(artifact: ParsedArtifactFile): Promise<void> {
        const resolved = artifact.vars.length > 0
            ? await resolveVarsInteractive(artifact.vars)
            : {};
        if (resolved === null) { return; }
        performInsert(this.targetEditor, artifact, resolved);
    }

    private relPath(uri: vscode.Uri): string {
        const root = this.rootUri.fsPath;
        const p    = uri.fsPath;
        if (p === root) { return ''; }
        return p.startsWith(root) ? p.slice(root.length + 1).replaceAll('\\', ' / ') : '';
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves once the popup webview posts an `insert` or
 * `cancel` message. Also resolves null if the panel is disposed before that.
 */
function waitForEditMessage(panel: vscode.WebviewPanel): Promise<Record<string, string> | null> {
    return new Promise(resolve => {
        const subs: vscode.Disposable[] = [];
        const done = (result: Record<string, string> | null) => {
            subs.forEach(s => s.dispose());
            resolve(result);
        };
        subs.push(
            panel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'insert') { done(msg.vars as Record<string, string>); }
                else { done(null); }
            }),
            panel.onDidDispose(() => done(null))
        );
    });
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
        ? `$(symbol-variable)  ${parsed.vars.map(v => v.name + '=' + v.defaultValue).join('  |  ')}`
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
 * Prompts the user for each variable's value via `showInputBox`.
 *
 * Labels are derived from the variable name via `labelForVar` — e.g.
 * `VK-min_price` becomes "Min price". Returns `null` if the user cancels any box.
 *
 * @param vars - Ordered list of variables to prompt for.
 * @returns Resolved `{ name → value }` map, or `null` on cancel.
 *
 * @example
 * const values = await resolveVarsInteractive(artifact.vars);
 * if (values !== null) { performInsert(editor, artifact, values); }
 */
async function resolveVarsInteractive(vars: ParsedVar[]): Promise<Record<string, string> | null> {
    const result: Record<string, string> = {};
    for (const v of vars) {
        const label = labelForVar(v.name);
        const value = await vscode.window.showInputBox({
            title: label, prompt: `Enter a value for ${label}`,
            value: v.defaultValue, placeHolder: v.defaultValue || label, ignoreFocusOut: true,
        });
        if (value === undefined) { return null; }
        result[v.name] = value;
    }
    return result;
}

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
 * Renders the read-only artifact preview HTML.
 *
 * @param a         - Parsed artifact to display.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @param cspSource - Webview CSP source token (from `webview.cspSource`).
 *
 * @example
 * panel.webview.html = renderPreviewHtml(artifact, cssUri, cspSource);
 */
function renderPreviewHtml(
    a: ParsedArtifactFile,
    codeHtml: string,
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
    const varsHtml = a.vars.length > 0
        ? `<table class="vt"><thead><tr><th>Variable</th><th>Default</th></tr></thead><tbody>${
            a.vars.map(v => `<tr><td><code>${e(v.name)}</code></td><td class="def">${e(v.defaultValue) || '<em>—</em>'}</td></tr>`).join('')
          }</tbody></table>`
        : `<p class="muted">No variables defined.</p>`;

    return popupShell(/* html */`
    <h1>${title}</h1>
    <div class="badges">
      <span class="badge">${type}</span>
      ${lang ? `<span class="badge lang">${lang}</span>` : ''}
      ${env}${target}
    </div>
    ${desc ? `<p class="desc">${desc}</p>` : ''}
    ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ''}
    ${codeHtml ? `<div class="slabel">Content</div>${codeHtml}` : ''}
    <div class="slabel">Variables</div>
    ${varsHtml}
    <p class="path">${e(a.relativePath)}</p>
    <p class="hint">Press Enter in the file list to edit variables and insert.</p>`,
    cssUri, cspSource);
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

// ── Popup HTML: edit mode (interactive) ──────────────────────────────────────

/**
 * Renders the interactive variable-editing HTML for a selected artifact.
 *
 * @param a         - Parsed artifact to edit.
 * @param nonce     - CSP nonce for the inline script.
 * @param cssUri    - Webview URI for the shared stylesheet.
 * @param cspSource - Webview CSP source token (from `webview.cspSource`).
 *
 * @example
 * panel.webview.html = renderEditHtml(artifact, getNonce(), cssUri, cspSource);
 */
function renderEditHtml(
    a: ParsedArtifactFile,
    nonce: string,
    codeHtml: string,
    cssUri: string,
    cspSource: string
): string {
    const e = escHtml;
    const title = e(a.frontmatter.title || a.fileName);
    const type  = e(a.frontmatter.type);
    const lang  = a.frontmatter.language ? e(a.frontmatter.language) : '';
    const desc  = a.frontmatter.description ? e(a.frontmatter.description) : '';

    const inputsHtml = a.vars.length > 0
        ? `<div class="slabel">Variables</div>
           <div class="inputs">${a.vars.map(v => `
             <div class="input-row">
               <label for="v-${e(v.name)}">${e(labelForVar(v.name))}</label>
               <input id="v-${e(v.name)}" data-var="${e(v.name)}" type="text"
                      value="${e(v.defaultValue)}" placeholder="${e(labelForVar(v.name))}">
             </div>`).join('')}
           </div>`
        : '<p class="muted">No variables — ready to insert.</p>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
</head>
<body class="popup-body">
  <h1>${title}</h1>
  <div class="badges">
    <span class="badge">${type}</span>
    ${lang ? `<span class="badge lang">${lang}</span>` : ''}
  </div>
  ${desc ? `<p class="desc">${desc}</p>` : ''}
  ${codeHtml ? `<div class="slabel">Content</div>${codeHtml}` : ''}
  ${inputsHtml}
  <div class="actions">
    <button class="btn btn-insert" id="insertBtn">Insert</button>
    <button class="btn btn-cancel" id="cancelBtn">Cancel</button>
  </div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  document.getElementById('insertBtn').addEventListener('click', () => {
    const vars = {};
    document.querySelectorAll('[data-var]').forEach(el => {
      vars[el.dataset.var] = el.value;
    });
    vscode.postMessage({ command: 'insert', vars });
  });
  document.getElementById('cancelBtn').addEventListener('click', () => {
    vscode.postMessage({ command: 'cancel' });
  });
  // Allow Ctrl/Cmd+Enter to insert from a focused input
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      document.getElementById('insertBtn').click();
    }
  });
  // Focus first input if any
  const first = document.querySelector('.input-row input');
  if (first) { first.focus(); }
})();
</script>
</body>
</html>`;
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
