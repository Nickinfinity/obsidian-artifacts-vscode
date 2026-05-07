import type { ApplyChange } from '../../../types/varset.types.js';
import { escHtml } from './preview.helpers.js';

/**
 * Renders the variable-set diff confirmation HTML — a table that lists every
 * change `applyVarSet` produced (filled, overridden, kept) plus Apply / Cancel
 * buttons. The host webview replaces its variables-section innerHTML with
 * this fragment so the user can confirm before committing.
 *
 * Posts `confirmApply` or `cancelApply` on button click. Markup uses class
 * names defined in `src/ui/styles.css` under `── Variable-set diff preview ──`.
 *
 * @param changes    - Per-var change rows from `ApplyResult.changes`.
 * @param subSetName - Human-readable heading of the picked sub-set (used in title).
 * @returns HTML fragment ready to drop into the variables section.
 *
 * @example
 * panel.webview.postMessage({ command: 'showVarSetDiff', html: renderVarSetDiffHtml(changes, 'Local Dev') });
 */
export function renderVarSetDiffHtml(changes: ApplyChange[], subSetName: string): string {
    const e = escHtml;
    const safeName = e(subSetName);

    const rowsHtml = changes.map(c => {
        const oldCell = c.oldValue === ''
            ? '<span class="empty">∅</span>'
            : `<code>${e(c.oldValue)}</code>`;
        const newCell = c.newValue === ''
            ? '<span class="empty">∅</span>'
            : `<code>${e(c.newValue)}</code>`;
        const klass = `diff-${c.action}`;
        const statusLabel = e(c.action);
        return /* html */`
        <tr class="${klass}">
          <td><code>${e(c.name)}</code></td>
          <td>${oldCell}</td>
          <td>${newCell}</td>
          <td>${statusLabel}</td>
        </tr>`;
    }).join('');

    return /* html */`
    <div class="varset-diff" data-varset-diff>
      <p class="varset-diff-title">Apply "${safeName}"?</p>
      <table class="varset-diff-table">
        <thead>
          <tr>
            <th>Variable</th>
            <th>Current</th>
            <th>New</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="actions">
        <button class="btn btn-insert"    id="varSetApplyBtn">Apply</button>
        <button class="btn btn-cancel"    id="varSetCancelBtn">Cancel</button>
      </div>
    </div>`;
}
