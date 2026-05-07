import * as vscode from 'vscode';
import { extractSubSets, scoreVarSet, VarSetScanner } from '../../services/varset.service.js';
import type { ParsedVar } from '../../types/parsed-artifact.types.js';
import type { VarSetMatch, VarSubSet } from '../../types/varset.types.js';

/** Module-private scanner singleton — cache survives across `pickVarSet` calls. */
const sharedScanner = new VarSetScanner();

/**
 * Returns the shared `VarSetScanner` instance so the orchestrator can call
 * `invalidate()` after writing a new variable-set file.
 *
 * @returns The module-level scanner singleton.
 *
 * @example
 * getVarSetScanner().invalidate();
 */
export function getVarSetScanner(): VarSetScanner {
    return sharedScanner;
}

/**
 * One row in the QuickPick — wraps a `VarSubSet` and its score against the
 * artifact, plus the formatted strings VS Code renders for the row.
 */
interface VarSubSetItem extends vscode.QuickPickItem {
    subSet: VarSubSet;
    match:  VarSetMatch;
}

/**
 * Opens a QuickPick listing every variable sub-set found under the vault's
 * `Variables/` directory, ranked by score against the active artifact.
 *
 * Sub-sets come from two sources, transparently flattened into one list:
 * - Multi-block variable files contribute one item per `## Heading`.
 * - Single-block variable files contribute one item using the file title.
 *
 * @param artifactVars     - Vars declared by the artifact being inserted.
 * @param artifactTags     - Tags from the artifact's frontmatter.
 * @param variablesDirUri  - Absolute URI of the vault's `Variables/` directory.
 * @param _extensionUri    - Reserved for future webview-based picker variant.
 * @returns Selected sub-set + its score report, or `null` when the user cancels.
 *
 * @example
 * const result = await pickVarSet(artifact.vars, artifact.frontmatter.tags ?? [], varsDir, extensionUri);
 * if (result) { applyVarSet(currentValues, result.subSet.vars); }
 */
export async function pickVarSet(
    artifactVars:    ParsedVar[],
    artifactTags:    string[],
    variablesDirUri: vscode.Uri,
    _extensionUri:   vscode.Uri,
): Promise<{ subSet: VarSubSet; match: VarSetMatch } | null> {
    // ── Collect & score every candidate sub-set ───────────────────────────────
    const files = await sharedScanner.scan(variablesDirUri);

    const items: VarSubSetItem[] = [];
    for (const file of files) {
        const subSets = extractSubSets(file);
        for (const subSet of subSets) {
            const match = scoreVarSet(artifactVars, artifactTags, subSet.vars, file.frontmatter.tags ?? []);
            items.push({
                subSet,
                match,
                label:       `$(symbol-variable) ${subSet.heading}`,
                description: file.frontmatter.title || file.fileName,
                detail:      formatDetail(match, subSet.vars.length),
            });
        }
    }

    if (items.length === 0) {
        void vscode.window.showInformationMessage(
            'No variable sets found. Create a `type: variables` file in the vault\'s Variables/ directory.',
        );
        return null;
    }

    // ── Sort by score descending so best matches surface first ────────────────
    items.sort((a, b) => b.match.score - a.match.score);

    // ── Show QuickPick and await user selection ───────────────────────────────
    const picked = await vscode.window.showQuickPick(items, {
        title:       'Apply Variable Set',
        placeHolder: 'Pick a variable set — sorted by match score',
        matchOnDescription: true,
        matchOnDetail:      true,
    });

    if (!picked) { return null; }
    return { subSet: picked.subSet, match: picked.match };
}

/**
 * Formats a `VarSetMatch` as a one-line `detail` string for the QuickPick row.
 *
 * Shows matched/total var counts and tag-match counts using VS Code codicons.
 *
 * @param match    - Score report from `scoreVarSet`.
 * @param setSize  - Total number of vars in the candidate sub-set.
 * @returns Single-line detail string.
 *
 * @example
 * formatDetail({ matchedVars: ['a', 'b'], unmatchedVars: ['c'], extraVars: [], tagMatches: 1, ... }, 2)
 * // → '$(check) 2/3 vars match · $(tag) 1 tag match'
 */
function formatDetail(match: VarSetMatch, setSize: number): string {
    const totalArtifactVars = match.matchedVars.length + match.unmatchedVars.length;
    const varSegment = `$(check) ${match.matchedVars.length}/${totalArtifactVars} vars match`;
    const tagWord    = match.tagMatches === 1 ? 'tag' : 'tags';
    const tagSegment = `$(tag) ${match.tagMatches} ${tagWord} match`;
    const extraSegment = match.extraVars.length > 0 ? ` · $(plus) ${match.extraVars.length} extra` : '';
    void setSize;
    return `${varSegment} · ${tagSegment}${extraSegment}`;
}
