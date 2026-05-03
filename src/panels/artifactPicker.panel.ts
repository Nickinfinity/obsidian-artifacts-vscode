import * as vscode from 'vscode';
import { parseFromContent } from '../services/parser.service.js';
import { getNonce } from '../utils/helpers.js';
import type { ParsedArtifactFile, ParsedVar } from '../types/parsed-artifact.types.js';

/** QuickPick item with optional vault-specific metadata. */
interface ArtifactItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    isDirectory?: boolean;
    isBack?: boolean;
}

const POPUP_VIEW_TYPE        = 'obsidianArtifactPopupPreview';
const PREVIEW_DEBOUNCE_MS    = 120;
const MAX_CODE_PREVIEW_CHARS = 1200;

const out = vscode.window.createOutputChannel('Obsidian Artifacts');

/**
 * Opens a QuickPick navigator for the given vault artifact directory.
 *
 * While the user navigates, a popup WebviewPanel beside the editor shows parsed
 * metadata + code + variable defaults (read-only preview mode).
 * When the user presses Enter on a file, the QuickPick closes, the popup switches
 * to interactive edit mode (editable variable inputs + Insert button), and the
 * extension waits for the user to confirm or cancel inside the panel.
 */
export async function openArtifactPicker(artifactDir: string, artifactName: string): Promise<void> {
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
        if ((stat.type & vscode.FileType.Directory) === 0) { throw new Error(); }
    } catch {
        vscode.window.showErrorMessage(`Obsidian Artifacts: Directory "${artifactDir}" not found in your vault.`);
        return;
    }

    const targetEditor = vscode.window.activeTextEditor;
    await new ArtifactNavigator(rootUri, artifactName, targetEditor).run();
}

// ── ArtifactNavigator ─────────────────────────────────────────────────────────

class ArtifactNavigator {
    private readonly qp: vscode.QuickPick<ArtifactItem>;
    private readonly rootUri: vscode.Uri;
    private readonly artifactName: string;
    private readonly targetEditor: vscode.TextEditor | undefined;
    private readonly parseCache = new Map<string, ParsedArtifactFile>();
    private readonly refreshedUris = new Set<string>();

    private currentDir: vscode.Uri;
    private dirStack: vscode.Uri[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    // The popup panel serves two roles:
    // • preview mode  — read-only metadata display while navigating
    // • edit mode     — interactive variable inputs + Insert button after file selection
    private popupPanel: vscode.WebviewPanel | undefined;

    // When true, onDidHide will NOT dispose the popup (because handleAccept will
    // keep it alive and switch it to edit mode).
    private keepPopupOnHide = false;

    private lastPreviewedUri = '';

    constructor(rootUri: vscode.Uri, artifactName: string, targetEditor: vscode.TextEditor | undefined) {
        this.rootUri      = rootUri;
        this.currentDir   = rootUri;
        this.artifactName = artifactName;
        this.targetEditor = targetEditor;

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

        // Trigger initial preview — onDidChangeActive may not fire automatically
        // when the QuickPick first shows.
        setTimeout(() => {
            const [first] = this.qp.activeItems;
            if (first) { void this.handleActiveChange([first]); }
        }, 60);
    }

    // ── Active change → preview mode ──────────────────────────────────────────

    private async handleActiveChange(items: readonly ArtifactItem[]): Promise<void> {
        const item = items[0];
        out.appendLine(`[active] "${item?.label ?? ''}" isDir=${item?.isDirectory} uri=${item?.uri?.fsPath ?? ''}`);

        if (!item || item.isBack || item.isDirectory || !item.uri) {
            if (this.popupPanel) { this.popupPanel.webview.html = renderPopupEmptyHtml(); }
            return;
        }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) { return; }

        this.refreshItem(item.uri, artifact);

        const key = item.uri.toString();
        if (key === this.lastPreviewedUri) { return; }
        this.lastPreviewedUri = key;

        this.showPreviewPanel(artifact);
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
    private showPreviewPanel(artifact: ParsedArtifactFile): void {
        if (!this.popupPanel) {
            try {
                this.popupPanel = vscode.window.createWebviewPanel(
                    POPUP_VIEW_TYPE,
                    'Artifact Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                    { enableScripts: true, retainContextWhenHidden: true }
                );
                this.popupPanel.onDidDispose(() => { this.popupPanel = undefined; });
                out.appendLine(`[popup] created`);
            } catch (err) {
                out.appendLine(`[popup] create FAILED: ${(err as Error).message}`);
                return;
            }
        }
        this.popupPanel.webview.html = renderPreviewHtml(artifact);
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

        if (!item.uri) { return; }

        const artifact = await this.getOrParse(item.uri);
        if (!artifact) {
            vscode.window.showErrorMessage('Obsidian Artifacts: Could not read file.');
            return;
        }

        // ── File selected: switch popup to edit mode ───────────────────────────
        // Tell onDidHide to leave the popup alive — we're handing it to edit mode.
        this.keepPopupOnHide = true;
        this.qp.hide();

        // Ensure the popup panel exists (the user might have pressed Enter before
        // the 120 ms debounce fired and created it).
        if (!this.popupPanel) {
            try {
                this.popupPanel = vscode.window.createWebviewPanel(
                    POPUP_VIEW_TYPE,
                    'Artifact Preview',
                    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
                    { enableScripts: true, retainContextWhenHidden: true }
                );
                this.popupPanel.onDidDispose(() => { this.popupPanel = undefined; });
            } catch (err) {
                out.appendLine(`[popup] create FAILED in accept: ${(err as Error).message}`);
                // Fall back to showInputBox
                await this.insertWithInputBoxFallback(artifact);
                return;
            }
        }

        // Switch to interactive edit mode and bring it into focus.
        this.popupPanel.webview.html = renderEditHtml(artifact, getNonce());
        this.popupPanel.reveal(this.popupPanel.viewColumn, false /* take focus */);
        out.appendLine(`[popup] edit mode → ${artifact.fileName}`);

        // Wait for the user to click Insert or Cancel inside the panel.
        const vars = await waitForEditMessage(this.popupPanel);
        this.popupPanel?.dispose();
        this.popupPanel = undefined;

        if (vars !== null) {
            performInsert(this.targetEditor, artifact, vars);
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
        return p.startsWith(root) ? p.slice(root.length + 1).replace(/\\/g, ' / ') : '';
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

// ── QuickPick item builder ────────────────────────────────────────────────────

/**
 * Builds a richly populated `ArtifactItem`.
 *
 * - `label`       — `$(file)  <title>` (filename fallback).
 * - `description` — `[type] language · description` (relative-path fallback).
 * - `detail`      — Tags only; variable info belongs in the popup preview.
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

    const title    = parsed?.frontmatter.title || fallback;
    const typePart = parsed ? `[${parsed.frontmatter.type}]` : '';
    const langPart = parsed?.frontmatter.language ?? '';
    const descPart = parsed?.frontmatter.description ?? relFsPath(uri, rootFs);
    const descHead = [typePart, langPart].filter(Boolean).join(' ');
    const description = descHead ? `${descHead} · ${descPart}` : descPart;

    const tags   = parsed?.frontmatter.tags ?? [];
    const detail = tags.length ? `$(tag) ${tags.join(', ')}` : undefined;

    return { label: `$(file)  ${title}`, description, detail, uri, isDirectory: false };
}

function relFsPath(uri: vscode.Uri, rootFs: string): string {
    const p = uri.fsPath;
    return (p.startsWith(rootFs + '/') || p.startsWith(rootFs + '\\'))
        ? p.slice(rootFs.length + 1).replace(/\\/g, '/')
        : p;
}

// ── Insert helpers ────────────────────────────────────────────────────────────

async function resolveVarsInteractive(vars: ParsedVar[]): Promise<Record<string, string> | null> {
    const result: Record<string, string> = {};
    for (const v of vars) {
        const value = await vscode.window.showInputBox({
            title: `Variable: ${v.name}`, prompt: `Enter a value for {{${v.name}}}`,
            value: v.defaultValue, placeHolder: v.defaultValue || v.name, ignoreFocusOut: true,
        });
        if (value === undefined) { return null; }
        result[v.name] = value;
    }
    return result;
}

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

function resolveVars(code: string, vars: Record<string, string>): string {
    return code.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
        const key = name.trim();
        return key in vars ? vars[key] : `{{${key}}}`;
    });
}

// ── Popup HTML: preview mode (read-only) ─────────────────────────────────────

function renderPreviewHtml(a: ParsedArtifactFile): string {
    const e = escHtml;
    const title    = e(a.frontmatter.title || a.fileName);
    const type     = e(a.frontmatter.type);
    const lang     = a.frontmatter.language ? e(a.frontmatter.language) : '';
    const desc     = a.frontmatter.description ? e(a.frontmatter.description) : '';
    const env      = a.frontmatter.env ? `<span class="pill">env: ${e(a.frontmatter.env)}</span>` : '';
    const target   = a.frontmatter.target ? `<span class="pill">target: ${e(a.frontmatter.target)}</span>` : '';
    const tagsHtml = (a.frontmatter.tags ?? []).map(t => `<span class="tag">${e(t)}</span>`).join('');
    const codeRaw  = a.code.length > MAX_CODE_PREVIEW_CHARS ? a.code.slice(0, MAX_CODE_PREVIEW_CHARS) + '\n…' : a.code;
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
    ${codeRaw ? `<div class="slabel">Content</div><pre class="code">${e(codeRaw)}</pre>` : ''}
    <div class="slabel">Variables</div>
    ${varsHtml}
    <p class="path">${e(a.relativePath)}</p>
    <p class="hint">Press Enter in the file list to edit variables and insert.</p>`);
}

// ── Popup HTML: edit mode (interactive) ──────────────────────────────────────

function renderEditHtml(a: ParsedArtifactFile, nonce: string): string {
    const e = escHtml;
    const title = e(a.frontmatter.title || a.fileName);
    const type  = e(a.frontmatter.type);
    const lang  = a.frontmatter.language ? e(a.frontmatter.language) : '';
    const desc  = a.frontmatter.description ? e(a.frontmatter.description) : '';
    const codeRaw = a.code.length > MAX_CODE_PREVIEW_CHARS ? a.code.slice(0, MAX_CODE_PREVIEW_CHARS) + '\n…' : a.code;

    const inputsHtml = a.vars.length > 0
        ? `<div class="slabel">Variables</div>
           <div class="inputs">${a.vars.map(v => `
             <div class="input-row">
               <label for="v-${e(v.name)}"><code>${e(v.name)}</code></label>
               <input id="v-${e(v.name)}" data-var="${e(v.name)}" type="text"
                      value="${e(v.defaultValue)}" placeholder="${e(v.name)}">
             </div>`).join('')}
           </div>`
        : '<p class="muted">No variables — ready to insert.</p>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
${popupStyles()}
<style>
.inputs { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.input-row { display: flex; align-items: center; gap: 10px; }
.input-row label { min-width: 110px; flex-shrink: 0; font-size: 12px; }
.input-row label code { font-family: var(--vscode-editor-font-family, monospace); }
.input-row input {
  flex: 1; padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px; font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  outline: none;
}
.input-row input:focus { border-color: var(--vscode-focusBorder); }
.actions { display: flex; gap: 8px; margin-top: 4px; }
.btn {
  padding: 6px 16px; border: none; border-radius: 3px;
  font-size: 12px; cursor: pointer; font-family: var(--vscode-font-family);
}
.btn-insert {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.btn-insert:hover { background: var(--vscode-button-hoverBackground); }
.btn-cancel {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  border: 1px solid var(--vscode-panel-border);
}
.btn-cancel:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="badges">
    <span class="badge">${type}</span>
    ${lang ? `<span class="badge lang">${lang}</span>` : ''}
  </div>
  ${desc ? `<p class="desc">${desc}</p>` : ''}
  ${codeRaw ? `<div class="slabel">Content</div><pre class="code">${e(codeRaw)}</pre>` : ''}
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

function renderPopupEmptyHtml(): string {
    return popupShell('<p style="text-align:center;margin-top:40px">Select a file to preview</p>');
}

// ── Popup HTML shared shell + styles ─────────────────────────────────────────

function popupShell(body: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
${popupStyles()}
</head>
<body>${body}</body>
</html>`;
}

function popupStyles(): string {
    return /* html */`<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5;
  color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
  padding: 16px 18px 24px;
}
h1 { font-size: 17px; font-weight: 600; margin-bottom: 8px; line-height: 1.3; }
.badges { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.badge {
  padding: 2px 9px; border-radius: 12px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.5px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.badge.lang {
  background: transparent; color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
}
.pill {
  font-size: 11px; color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 1px 7px;
}
.desc { color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
.tags { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 12px; }
.tag { font-size: 11px; padding: 2px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; color: var(--vscode-descriptionForeground); }
.slabel { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--vscode-descriptionForeground); margin: 14px 0 6px; }
.code {
  background: var(--vscode-textCodeBlock-background, var(--vscode-sideBar-background));
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  max-height: 220px; overflow-y: auto; margin-bottom: 4px;
}
.vt { width: 100%; border-collapse: collapse; font-size: 12px; }
.vt th { text-align: left; padding: 4px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
.vt td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.vt code { font-family: var(--vscode-editor-font-family, monospace); }
.def { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
.muted { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; margin-top: 6px; }
.path { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 14px; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.6; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; opacity: 0.7; font-style: italic; }
</style>`;
}

function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
