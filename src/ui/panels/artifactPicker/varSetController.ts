import * as vscode from 'vscode';
import * as path from 'path';
import { applyVarSet } from '../../../services/varset.service.js';
import { ARTIFACTS } from '../../../types/constants.js';
import type { ParsedArtifactFile, ParsedVar } from '../../../types/parsed-artifact.types.js';
import type { ApplyResult, VarSubSet } from '../../../types/varset.types.js';
import { getVarSetScanner, pickVarSet } from '../varsetPicker.panel.js';
import { renderVarSetDiffHtml } from './varSetDiff.js';

/** Callbacks the controller uses to push state back to the host preview panel. */
export interface VarSetControllerCallbacks {
    /** Returns the artifact currently shown in the popup (`undefined` between switches). */
    getCurrentArtifact: () => ParsedArtifactFile | undefined;
    /** Posts a message to the popup webview. */
    postMessage: (msg: Record<string, unknown>) => void;
    /** Captures an applied sub-set so the source badge persists across re-renders. */
    rememberAppliedSet: (subSetName: string, varNames: string[]) => void;
}

/**
 * Owns the variable-set message flow inside the preview panel:
 * `pickVarSet`  → QuickPick → diff preview
 * `confirmApply` / `cancelApply` → finalise
 * `saveAsVarSet` → write a new `Variables/<slug>.md` file.
 *
 * Stateless across artifacts — the active sub-set is held only between the
 * QuickPick acceptance and the user's confirm/cancel decision.
 *
 * @example
 * const ctrl = new VarSetController(extensionUri, { getCurrentArtifact, postMessage, rememberAppliedSet });
 * await ctrl.handlePickVarSet({ values: { 'VK-host': '' } });
 */
export class VarSetController {

    /** Pending `ApplyResult` between `pickVarSet` selection and `confirmApply`. */
    private pending: { subSet: VarSubSet; result: ApplyResult } | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly cb: VarSetControllerCallbacks,
    ) {}

    /**
     * Opens the QuickPick, computes the diff, and posts the diff HTML to the webview.
     *
     * @param msg - Webview payload — must contain `values: Record<string, string>`
     *              with the user's current input map.
     * @returns Resolves once the diff has been posted (or no-op on cancel).
     *
     * @example
     * await ctrl.handlePickVarSet({ values: collectVars() });
     */
    async handlePickVarSet(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }

        const variablesDirUri = getVariablesDirUri();
        if (!variablesDirUri) {
            void vscode.window.showErrorMessage('Variables directory is not configured. Open the Settings panel to enable it.');
            return;
        }

        const picked = await pickVarSet(
            artifact.vars,
            artifact.frontmatter.tags ?? [],
            variablesDirUri,
            this.extensionUri,
        );
        if (!picked) { return; }

        const currentValues = (msg.values as Record<string, string> | undefined) ?? {};
        const result = applyVarSet(currentValues, picked.subSet.vars);
        this.pending = { subSet: picked.subSet, result };

        this.cb.postMessage({
            command:    'showVarSetDiff',
            html:       renderVarSetDiffHtml(result.changes, picked.subSet.heading),
            subSetName: picked.subSet.heading,
        });
    }

    /**
     * Finalises the pending apply — pushes merged values + source-badge metadata to the webview.
     *
     * @returns void
     *
     * @example
     * ctrl.handleConfirmApply();
     */
    handleConfirmApply(): void {
        const pending = this.pending;
        if (!pending) { return; }

        const filledOrOverriddenNames = pending.result.changes
            .filter(c => c.action === 'filled' || c.action === 'overridden')
            .map(c => c.name);

        this.cb.rememberAppliedSet(pending.subSet.heading, filledOrOverriddenNames);

        this.cb.postMessage({
            command:    'varSetApplied',
            values:     pending.result.values,
            subSetName: pending.subSet.heading,
            varNames:   filledOrOverriddenNames,
        });
        this.pending = undefined;
    }

    /**
     * Aborts the pending apply — webview reverts the diff view back to inputs.
     *
     * @returns void
     *
     * @example
     * ctrl.handleCancelApply();
     */
    handleCancelApply(): void {
        this.pending = undefined;
        this.cb.postMessage({ command: 'varSetCancelled' });
    }

    /**
     * Implements the save-as-variable-set flow — prompts for title and description,
     * builds a new `.md` file under `Variables/<slug>.md`, writes it, and invalidates
     * the scanner cache so the next pick run sees the new file.
     *
     * @param msg - Webview payload — must contain `values: Record<string, string>`
     *              with the user's current non-empty input map.
     * @returns Resolves once the file is written or after the user cancels a prompt.
     *
     * @example
     * await ctrl.handleSaveAsVarSet({ values: { 'VK-host': 'localhost' } });
     */
    async handleSaveAsVarSet(msg: Record<string, unknown>): Promise<void> {
        const artifact = this.cb.getCurrentArtifact();
        if (!artifact) { return; }

        const values = (msg.values as Record<string, string> | undefined) ?? {};
        const nonEmpty: [string, string][] = Object.entries(values).filter(([, v]) => v.length > 0);
        if (nonEmpty.length === 0) {
            void vscode.window.showInformationMessage('No values to save — fill at least one variable first.');
            return;
        }

        const variablesDirUri = getVariablesDirUri();
        if (!variablesDirUri) {
            void vscode.window.showErrorMessage('Variables directory is not configured. Open the Settings panel to enable it.');
            return;
        }

        const title = await vscode.window.showInputBox({
            prompt: 'Name for this variable set',
            placeHolder: 'e.g. Local Development',
            validateInput: v => v.trim().length === 0 ? 'Name cannot be empty.' : undefined,
        });
        if (!title) { return; }

        const description = await vscode.window.showInputBox({
            prompt: 'Description (optional)',
            placeHolder: 'Short context for this variable set',
        });
        // User can dismiss the description prompt — that aborts the save flow.
        if (description === undefined) { return; }

        const tags    = artifact.frontmatter.tags ?? [];
        const content = buildVarSetFileContent(title.trim(), description.trim(), tags, nonEmpty);
        const slug    = slugify(title);
        const fileUri = vscode.Uri.joinPath(variablesDirUri, `${slug}.md`);

        try {
            await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
            getVarSetScanner().invalidate();
            void vscode.window.showInformationMessage(`Variable set saved: ${title.trim()}`);
        } catch (err) {
            void vscode.window.showErrorMessage(`Failed to save variable set: ${(err as Error).message}`);
        }
    }
}

// ── Module helpers ────────────────────────────────────────────────────────────

/**
 * Resolves the configured `<vault>/Variables` directory URI from VS Code settings.
 *
 * @returns The directory URI, or `null` when `obsidianArtifacts.vaultPath` is unset.
 *
 * @example
 * const dir = getVariablesDirUri();
 */
function getVariablesDirUri(): vscode.Uri | null {
    const vaultPath = vscode.workspace
        .getConfiguration('obsidianArtifacts')
        .get<string>('vaultPath', '')
        .trim();
    if (vaultPath.length === 0) { return null; }
    const variablesDir = ARTIFACTS.find(a => a.dir === 'Variables')?.dir ?? 'Variables';
    return vscode.Uri.file(path.join(vaultPath, variablesDir));
}

/**
 * Builds the `.md` file body for a saved variable set.
 *
 * @param title       - Display title — written verbatim into the frontmatter.
 * @param description - Optional description; emitted only when non-empty.
 * @param tags        - Tags copied from the active artifact's frontmatter.
 * @param entries     - Ordered `[name, value]` pairs to embed in the `vars` fence.
 * @returns Full file content as a single UTF-8 string.
 *
 * @example
 * buildVarSetFileContent('Local Dev', '', ['api'], [['VK-host', 'localhost']]);
 */
function buildVarSetFileContent(
    title:       string,
    description: string,
    tags:        string[],
    entries:     [string, string][],
): string {
    const lines: string[] = ['---', 'type: variables', `title: ${title}`];
    if (description.length > 0) { lines.push(`description: ${description}`); }
    if (tags.length > 0)        { lines.push(`tags: [${tags.join(', ')}]`); }
    lines.push('---', '', '```vars');
    for (const [name, value] of entries) { lines.push(`${name}=${value}`); }
    lines.push('```', '');
    return lines.join('\n');
}

/**
 * Slugifies a title into a safe file-name stem: lowercase letters/digits with
 * single hyphens between runs, no leading/trailing hyphen.
 *
 * @param title - Raw user-typed title.
 * @returns A file-system safe slug (always at least one character).
 *
 * @example
 * slugify('Local Development!') // → 'local-development'
 */
function slugify(title: string): string {
    const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/(^-|-$)/g, '');
    return slug.length > 0 ? slug : 'untitled-variable-set';
}

// ── ParsedVar export — helps consumers avoid an extra import ─────────────────
export type { ParsedVar };
