import * as vscode from 'vscode';
import { parseFromContent } from '../../../services/parser.service.js';
import { renderCodeHtml, renderCodeRowsHtml } from '../../../services/render.service.js';
import { patchFrontmatterField, patchVarDefaults } from '../../../services/artifact-patcher.service.js';
import { PreviewModeController, type SectionKey } from '../../../services/preview-mode.service.js';
import { getNonce } from '../../../utils/helpers.js';
import type { ParsedArtifactFile, ParsedVar } from '../../../types/parsed-artifact.types.js';
import { out } from './shared.js';
import {
    POPUP_VIEW_TYPE,
    blockAsArtifact as _blockAsArtifact,  // re-exported for navigator use
    escHtml,
    labelForVar,
    performInsert,
    popupShell,
} from './preview.helpers.js';
import { buildCodeBlockHtml, CODE_BLOCK_CLIENT_JS } from './codeBlock.js';
import { FullEditController } from './fullEditor.js';
import { VarSetController } from './varSetController.js';

// Re-export the adapter so the navigator does not need to import preview.helpers directly.
export const blockAsArtifact = _blockAsArtifact;

/** Callback bag the controller uses to push state back to the navigator. */
export interface PreviewCallbacks {
    extensionUri: vscode.Uri;
    rootFs: string;
    targetEditor: vscode.TextEditor | undefined;
    /** Updates the navigator's parse cache after a save round-trip. */
    setCache: (uri: vscode.Uri, parsed: ParsedArtifactFile) => void;
    /** Notifies the navigator that the popup webview has been disposed. */
    onDispose: () => void;
    /** Closes the QuickPick (called from `handleInsert`). */
    closePicker: () => void;
}

/**
 * Owns the popup `WebviewPanel` lifecycle, all preview HTML rendering, the
 * webview ↔ extension message protocol, and the embedded `FullEditController`.
 *
 * Created lazily by the navigator once the user starts hovering an item.
 *
 * @example
 * const ctrl = new PreviewPanelController({ extensionUri, rootFs, targetEditor, setCache, onDispose, closePicker });
 * await ctrl.showPreview(artifact);
 */
export class PreviewPanelController {
    private panel: vscode.WebviewPanel | undefined;
    private cssUri    = '';
    private cspSource = '';
    private currentArtifact: ParsedArtifactFile | undefined;
    private modeController: PreviewModeController | undefined;
    private msgSub: vscode.Disposable | undefined;
    private readonly fullEdit: FullEditController;
    private readonly varSet:   VarSetController;

    constructor(private readonly cb: PreviewCallbacks) {
        this.fullEdit = new FullEditController({
            rootFs:              cb.rootFs,
            getCurrentArtifact:  () => this.currentArtifact,
            setCurrentArtifact:  a => { this.currentArtifact = a; },
            setCache:            cb.setCache,
            postMessage:         msg => { void this.panel?.webview.postMessage(msg); },
        });
        this.varSet = new VarSetController(cb.extensionUri, {
            getCurrentArtifact: () => this.currentArtifact,
            postMessage:        msg => { void this.panel?.webview.postMessage(msg); },
            rememberAppliedSet: (subSetName, varNames) => {
                if (!this.modeController) { return; }
                for (const name of varNames) { this.modeController.setVarSource(name, subSetName); }
            },
        });
    }

    /** True when the popup panel currently exists (regardless of visibility). */
    isOpen(): boolean { return this.panel !== undefined; }

    /**
     * Brings the popup tab into view in its column.
     *
     * @param preserveFocus - When `true`, keeps focus on the QuickPick (used during
     *                        navigation).  Pass `false` after the picker hides to
     *                        focus the panel for interaction.
     */
    reveal(preserveFocus: boolean): void {
        this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus);
    }

    /** Disposes the popup panel — the dispose listener fires `cb.onDispose`. */
    dispose(): void { this.panel?.dispose(); }

    // ── Renderers ─────────────────────────────────────────────────────────────

    /**
     * Creates (once per session) or updates the popup in interactive preview mode.
     *
     * @param artifact - Single-block artifact to display.
     */
    showPreview(artifact: ParsedArtifactFile): void {
        this.fullEdit.teardown();
        this.currentArtifact = artifact;
        this.modeController  = new PreviewModeController(artifact.code);

        if (!this.ensurePanel()) { return; }

        const codeRowsHtml = renderCodeRowsHtml(artifact.code, artifact.frontmatter.language);
        const varSources   = this.modeController?.getAllVarSources() ?? {};
        this.panel!.webview.html = renderPreviewHtml(artifact, codeRowsHtml, getNonce(), this.cssUri, this.cspSource, varSources);
        this.setupMessageHandler();
        this.reveal(true);
        out.appendLine(`[popup] preview → ${artifact.fileName}`);
    }

    /**
     * Creates (once per session) or updates the popup with a stacked multi-block preview.
     *
     * @param artifact - Multi-block artifact to preview.
     */
    showMultiBlockPreview(artifact: ParsedArtifactFile): void {
        if (!this.ensurePanel()) { return; }

        const highlightedBlocks = artifact.blocks.map(b => ({
            heading:     b.heading,
            codeHtml:    renderCodeHtml(b.code, b.fenceLang ?? artifact.frontmatter.language),
            vars:        b.vars,
            description: b.description,
        }));
        this.panel!.webview.html = renderMultiBlockPreviewHtml(artifact, highlightedBlocks, this.cssUri, this.cspSource);
        this.reveal(true);
        out.appendLine(`[popup] multi-block preview → ${artifact.fileName} (${artifact.blocks.length} blocks)`);
    }

    /** Replaces the panel HTML with the empty-state placeholder. */
    showEmpty(): void {
        if (!this.panel) { return; }
        this.panel.webview.html = renderPopupEmptyHtml(this.cssUri, this.cspSource);
    }

    // ── Internal: panel lifecycle ─────────────────────────────────────────────

    private ensurePanel(): boolean {
        if (this.panel) { return true; }
        try {
            this.panel = vscode.window.createWebviewPanel(
                POPUP_VIEW_TYPE,
                'Artifact Preview',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                {
                    enableScripts:           true,
                    retainContextWhenHidden: true,
                    localResourceRoots:      [vscode.Uri.joinPath(this.cb.extensionUri, 'src', 'ui')],
                },
            );
            this.panel.onDidDispose(() => {
                this.fullEdit.teardown();
                this.msgSub?.dispose();
                this.msgSub          = undefined;
                this.panel           = undefined;
                this.modeController  = undefined;
                this.currentArtifact = undefined;
                this.cb.onDispose();
            });
            this.cssUri    = this.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.cb.extensionUri, 'src', 'ui', 'styles.css'),
            ).toString();
            this.cspSource = this.panel.webview.cspSource;
            out.appendLine(`[popup] created`);
            return true;
        } catch (err) {
            out.appendLine(`[popup] create FAILED: ${(err as Error).message}`);
            return false;
        }
    }

    // ── Internal: webview message routing ─────────────────────────────────────

    private setupMessageHandler(): void {
        this.msgSub?.dispose();
        this.msgSub = undefined;
        if (!this.panel) { return; }
        this.msgSub = this.panel.webview.onDidReceiveMessage(msg => {
            void this.handleMessage(msg as Record<string, unknown>);
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        const cmd = msg.command as string;
        if      (cmd === 'startEdit')     { this.modeController?.startEditingSection(msg.section as SectionKey); }
        else if (cmd === 'cancelEdit')    { this.modeController?.stopEditingSection(msg.section as SectionKey); }
        else if (cmd === 'quickEdit')     { this.modeController?.enterQuickEdit(); }
        else if (cmd === 'backToPreview') { this.modeController?.enterPreview(); }
        else if (cmd === 'fullEdit')      { this.handleFullEdit(); }
        else if (cmd === 'saveSection')   { await this.handleSaveSection(msg); }
        else if (cmd === 'insert')        { this.handleInsert(msg); }
        else if (cmd === 'cancel')        { this.dispose(); }
        else if (cmd === 'pickVarSet')    { await this.varSet.handlePickVarSet(msg); }
        else if (cmd === 'confirmApply')  { this.varSet.handleConfirmApply(); }
        else if (cmd === 'cancelApply')   { this.varSet.handleCancelApply(); }
        else if (cmd === 'saveAsVarSet')  { await this.varSet.handleSaveAsVarSet(msg); }
        else if (cmd === 'clearVarSource'){ this.modeController?.clearVarSource(msg.name as string); }
    }

    private handleFullEdit(): void {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        this.modeController?.enterFullEdit();
        this.fullEdit.start(vscode.Uri.file(artifact.filePath));
    }

    private async handleSaveSection(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.currentArtifact;
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
            const updated = parseFromContent(content, fileUri.fsPath, this.cb.rootFs);
            this.cb.setCache(fileUri, updated);
            this.currentArtifact = updated;
            this.modeController?.stopEditingSection(section as SectionKey);
            // sectionSaved before fileUpdated so the webview exits edit mode first,
            // then fileUpdated can safely update all non-editing sections.
            void this.panel?.webview.postMessage({ command: 'sectionSaved', section, success: true });
            void this.panel?.webview.postMessage({ command: 'fileUpdated', artifact: updated });
        } catch {
            void this.panel?.webview.postMessage({ command: 'sectionSaved', section, success: false });
        }
    }

    private handleInsert(msg: Record<string, unknown>): void {
        const artifact = this.currentArtifact;
        if (!artifact) { return; }
        const code         = this.resolveInsertCode(msg, artifact);
        const resolvedVars = mergeVarsWithDefaults(msg.vars as Record<string, string>, artifact.vars);

        performInsert(this.cb.targetEditor, { ...artifact, code }, resolvedVars);
        this.fullEdit.teardown();
        this.dispose();
        this.cb.closePicker();
    }

    /**
     * Picks the canonical code source for `Insert`:
     *   - fullEdit mode → live `.md` document content (may have unsaved external edits)
     *   - else          → `msg.code` from the contenteditable webview surface
     *   - fallback      → `artifact.code` (last parsed snapshot)
     */
    private resolveInsertCode(msg: Record<string, unknown>, artifact: ParsedArtifactFile): string {
        const mode = this.modeController?.mode ?? 'preview';
        if (mode === 'fullEdit') {
            const fileUri = vscode.Uri.file(artifact.filePath);
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
            if (openDoc) {
                return parseFromContent(openDoc.getText(), artifact.filePath, this.cb.rootFs).code;
            }
        }
        return typeof msg.code === 'string' ? msg.code : artifact.code;
    }
}

// ── Var-merge helper ─────────────────────────────────────────────────────────

/**
 * Three-tier resolution: user-typed value → defaultValue → omit (so `resolveVars`
 * leaves the `<VK-xxx>` token intact).
 *
 * @param raw  - Raw `{ name → value }` map collected from the webview inputs.
 * @param vars - Parsed vars from the artifact (each carries a `defaultValue`).
 *
 * @example
 * mergeVarsWithDefaults({ 'VK-host': '' }, [{ name: 'VK-host', defaultValue: 'localhost' }])
 * // → { 'VK-host': 'localhost' }
 */
function mergeVarsWithDefaults(raw: Record<string, string>, vars: ParsedVar[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const v of vars) {
        const collected = raw[v.name] ?? '';
        const effective = collected || v.defaultValue;
        if (effective) { out[v.name] = effective; }
    }
    return out;
}

// ── HTML renderers (private to this file — controller calls them above) ──────

/**
 * Renders the interactive artifact preview HTML.
 *
 * Embeds the editable code block (Part 2) inside the outer preview script
 * (Part 3); both share the same `vscode = acquireVsCodeApi()` IIFE.
 */
function renderPreviewHtml(
    a: ParsedArtifactFile,
    codeRowsHtml: string,
    nonce: string,
    cssUri: string,
    cspSource: string,
    varSources: Record<string, string> = {},
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
        ? a.vars.map(v => {
            const src = varSources[v.name];
            const badge = src ? `<span class="var-source" data-var-source="${e(v.name)}">from: ${e(src)}</span>` : '';
            return `
             <div class="input-row">
               <label for="v-${e(v.name)}">${e(labelForVar(v.name))}</label>
               <input id="v-${e(v.name)}" data-var="${e(v.name)}" type="text"
                      value="${e(v.defaultValue)}" placeholder="${e(labelForVar(v.name))}">
               ${badge}
             </div>`;
          }).join('')
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
  ${buildCodeBlockHtml(codeRowsHtml, lang)}
  <div class="slabel">Variables</div>
  <div id="varsSection">
    <div class="inputs" id="varInputs">${inputsHtml}</div>
    <div class="actions varset-actions">
      <button class="btn btn-secondary" id="applyVarSetBtn">Apply Variable Set</button>
      <button class="btn btn-secondary" id="saveAsVarSetBtn" style="display:none;">Save as Variable Set</button>
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-insert"    id="insertBtn">Insert</button>
    <button class="btn btn-secondary" id="editBtn">Edit .md</button>
    <button class="btn btn-cancel"    id="cancelBtn">Cancel</button>
  </div>
  <p class="path">${e(a.relativePath)}</p>
<script nonce="${nonce}">
(function () {
  const vscode    = acquireVsCodeApi();
  const varInputs = document.getElementById('varInputs');
  ${CODE_BLOCK_CLIENT_JS}

  // ── Buttons ──────────────────────────────────────────────────────────────
  function collectVars() {
    const out = {};
    document.querySelectorAll('[data-var]').forEach(function (el) { out[el.dataset.var] = el.value; });
    return out;
  }
  document.getElementById('insertBtn').addEventListener('click', function () {
    window.__codeBlock.flushPendingRender();
    vscode.postMessage({ command: 'insert', vars: collectVars(), code: window.__codeBlock.extractCode() });
  });
  document.getElementById('editBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'fullEdit' });
  });
  document.getElementById('cancelBtn').addEventListener('click', function () {
    vscode.postMessage({ command: 'cancel' });
  });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      document.getElementById('insertBtn').click();
    }
  });

  // ── Variable-set buttons ─────────────────────────────────────────────────
  const varsSection = document.getElementById('varsSection');
  let savedVarsHtml = null;  // snapshot of inputs HTML used to restore on cancelApply

  function refreshSaveBtn() {
    const btn = document.getElementById('saveAsVarSetBtn');
    if (!btn) { return; }
    const hasValue = Object.values(collectVars()).some(function (v) { return v && v.length > 0; });
    btn.style.display = hasValue ? '' : 'none';
  }

  const applyBtn = document.getElementById('applyVarSetBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      vscode.postMessage({ command: 'pickVarSet', values: collectVars() });
    });
  }
  const saveBtn = document.getElementById('saveAsVarSetBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      vscode.postMessage({ command: 'saveAsVarSet', values: collectVars() });
    });
  }
  varInputs.addEventListener('input', function (ev) {
    const t = ev.target;
    if (t && t.dataset && t.dataset.var) {
      // Manual edit removes the source badge for this var.
      const badge = varInputs.querySelector('[data-var-source="' + t.dataset.var + '"]');
      if (badge) {
        badge.remove();
        vscode.postMessage({ command: 'clearVarSource', name: t.dataset.var });
      }
    }
    refreshSaveBtn();
  });
  refreshSaveBtn();

  // ── updateVars / fileUpdated incoming messages ──────────────────────────
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
  // ── Var-set diff / applied / cancelled handlers ─────────────────────────
  function showDiffView(html) {
    if (!varsSection) { return; }
    if (savedVarsHtml === null) { savedVarsHtml = varsSection.innerHTML; }
    varsSection.innerHTML = html;
    const applyBtn  = document.getElementById('varSetApplyBtn');
    const cancelBtn = document.getElementById('varSetCancelBtn');
    if (applyBtn)  { applyBtn.addEventListener('click',  function () { vscode.postMessage({ command: 'confirmApply' }); }); }
    if (cancelBtn) { cancelBtn.addEventListener('click', function () { vscode.postMessage({ command: 'cancelApply'  }); }); }
  }
  function restoreVarsView() {
    if (!varsSection || savedVarsHtml === null) { return; }
    varsSection.innerHTML = savedVarsHtml;
    savedVarsHtml = null;
    refreshSaveBtn();
  }
  function applyValuesAndBadges(values, subSetName, varNames) {
    restoreVarsView();
    const inputs = document.querySelectorAll('[data-var]');
    inputs.forEach(function (el) {
      const name = el.dataset.var;
      if (Object.prototype.hasOwnProperty.call(values, name)) { el.value = values[name]; }
    });
    const flagged = new Set(varNames || []);
    flagged.forEach(function (name) {
      const input = varInputs.querySelector('[data-var="' + name + '"]');
      if (!input) { return; }
      const row = input.closest('.input-row');
      if (!row) { return; }
      const existing = row.querySelector('[data-var-source]');
      if (existing) { existing.remove(); }
      const badge = document.createElement('span');
      badge.className = 'var-source';
      badge.dataset.varSource = name;
      badge.textContent = 'from: ' + subSetName;
      row.appendChild(badge);
    });
    refreshSaveBtn();
  }

  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.command === 'updateVars')  { rebuildVarInputs(msg.vars); refreshSaveBtn(); }
    if (msg.command === 'fileUpdated' && msg.artifact) {
      window.__codeBlock.setCode(msg.artifact.code || '');
      rebuildVarInputs(msg.artifact.vars);
      refreshSaveBtn();
    }
    if (msg.command === 'showVarSetDiff') { showDiffView(msg.html); }
    if (msg.command === 'varSetApplied')  { applyValuesAndBadges(msg.values || {}, msg.subSetName || '', msg.varNames || []); }
    if (msg.command === 'varSetCancelled'){ restoreVarsView(); }
  });
})();
</script>
</body>
</html>`;
}

/**
 * Renders a stacked read-only preview of all blocks in a multi-block artifact.
 */
function renderMultiBlockPreviewHtml(
    a: ParsedArtifactFile,
    highlightedBlocks: { heading: string; codeHtml: string; vars: ParsedVar[]; description: string }[],
    cssUri: string,
    cspSource: string,
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

function renderPopupEmptyHtml(cssUri: string, cspSource: string): string {
    return popupShell(
        '<p style="text-align:center;margin-top:40px">Select a file to preview</p>',
        cssUri,
        cspSource,
    );
}
