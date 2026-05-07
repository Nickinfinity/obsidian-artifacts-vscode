/** Artifact sections that support inline editing. */
export type SectionKey = 'title' | 'description' | 'varDefaults';

/** Draft value type per section — string for text fields, map for var defaults. */
export type SectionDraft = string | Record<string, string>;

// ── PreviewModeController ─────────────────────────────────────────────────────

/**
 * Manages the display mode and per-section draft state of the artifact preview panel.
 *
 * **Mode lifecycle:**
 * - `preview`   — read-only; initial state.
 * - `quickEdit` — lightweight inline edit; reachable from `preview` only.
 * - `fullEdit`  — two-panel TempDocument edit; reachable from `preview` only.
 * - Transitioning `quickEdit → fullEdit` is invalid and throws.
 *
 * **Section drafts** are independent of the code mode — any section (`title`,
 * `description`, `varDefaults`) may be in edit state at any time.
 *
 * @example
 * ```ts
 * const ctrl = new PreviewModeController('const x = 1;');
 * ctrl.enterQuickEdit();
 * ctrl.setEditedCode('const x = 42;');
 * ctrl.startEditingSection('title');
 * ctrl.setSectionDraft('title', 'New Title');
 * ctrl.dispose();
 * ```
 */
export class PreviewModeController {

    private readonly originalCode: string;
    private editedCode: string | undefined;
    private currentMode: 'preview' | 'quickEdit' | 'fullEdit' = 'preview';

    // ── Section state ─────────────────────────────────────────────────────────
    private readonly editingSections = new Set<SectionKey>();
    private readonly sectionDrafts   = new Map<SectionKey, SectionDraft>();

    /**
     * @param originalCode - Artifact code string shown in preview mode and used
     *                       as the base for insertable content.
     * @example
     * const ctrl = new PreviewModeController('SELECT * FROM users;');
     */
    constructor(originalCode: string) {
        this.originalCode = originalCode;
    }

    // ── Mode ──────────────────────────────────────────────────────────────────

    /**
     * Current display mode.
     *
     * @returns `'preview'`, `'quickEdit'`, or `'fullEdit'`.
     *
     * @example
     * ctrl.mode; // 'preview'
     */
    get mode(): 'preview' | 'quickEdit' | 'fullEdit' {
        return this.currentMode;
    }

    /**
     * Transitions to `preview` mode from any mode.
     *
     * @returns `void`
     *
     * @example
     * ctrl.enterFullEdit();
     * ctrl.enterPreview(); // mode === 'preview'
     */
    enterPreview(): void {
        this.currentMode = 'preview';
    }

    /**
     * Transitions to `quickEdit` mode from `preview`.
     *
     * @returns `void`
     *
     * @example
     * ctrl.enterQuickEdit(); // mode === 'quickEdit'
     */
    enterQuickEdit(): void {
        this.currentMode = 'quickEdit';
    }

    /**
     * Transitions to `fullEdit` mode from `preview`.
     *
     * @throws {Error} When the current mode is `quickEdit` — that transition is invalid.
     * @returns `void`
     *
     * @example
     * ctrl.enterFullEdit(); // mode === 'fullEdit'
     */
    enterFullEdit(): void {
        if (this.currentMode === 'quickEdit') {
            throw new Error('Invalid transition: quickEdit → fullEdit is not allowed.');
        }
        this.currentMode = 'fullEdit';
    }

    /**
     * Stores a code string to return from `getInsertableCode` while in `quickEdit` mode.
     *
     * @param code - The edited code content.
     * @returns `void`
     *
     * @example
     * ctrl.setEditedCode('const x = 42;');
     */
    setEditedCode(code: string): void {
        this.editedCode = code;
    }

    /**
     * Returns the code to insert.
     *
     * - In `preview` mode: always returns the original code passed to the constructor.
     * - In `quickEdit` mode: returns the edited code if one was set via `setEditedCode`,
     *   otherwise falls back to the original.
     * - In `fullEdit` mode: returns the original (the caller reads TempDocument directly).
     *
     * @returns The code string ready for insertion.
     *
     * @example
     * ctrl.enterQuickEdit();
     * ctrl.setEditedCode('const x = 99;');
     * ctrl.getInsertableCode(); // 'const x = 99;'
     */
    getInsertableCode(): string {
        if (this.currentMode === 'quickEdit' && this.editedCode !== undefined) {
            return this.editedCode;
        }
        return this.originalCode;
    }

    // ── Section editing state ─────────────────────────────────────────────────

    /**
     * Marks a section as actively being edited.
     *
     * Multiple sections may be in edit state at the same time.
     *
     * @param section - Section key to activate.
     * @returns `void`
     *
     * @example
     * ctrl.startEditingSection('title');
     */
    startEditingSection(section: SectionKey): void {
        this.editingSections.add(section);
    }

    /**
     * Marks a section as read-only and discards its draft.
     *
     * No-op when the section was not editing.
     *
     * @param section - Section key to deactivate.
     * @returns `void`
     *
     * @example
     * ctrl.stopEditingSection('title'); // isEditingSection('title') → false
     */
    stopEditingSection(section: SectionKey): void {
        this.editingSections.delete(section);
        this.sectionDrafts.delete(section);
    }

    /**
     * Returns whether a section is currently in edit state.
     *
     * @param section - Section key to query.
     * @returns `true` while editing, `false` otherwise.
     *
     * @example
     * ctrl.startEditingSection('description');
     * ctrl.isEditingSection('description'); // true
     */
    isEditingSection(section: SectionKey): boolean {
        return this.editingSections.has(section);
    }

    /**
     * Stores a draft value for a section.
     *
     * Overwrites any previously stored draft for the same section.
     *
     * @param section - Target section key.
     * @param value   - Draft string (for `title`/`description`) or var-defaults map
     *                  (for `varDefaults`).
     * @returns `void`
     *
     * @example
     * ctrl.setSectionDraft('varDefaults', { 'VK-host': 'localhost' });
     */
    setSectionDraft(section: SectionKey, value: SectionDraft): void {
        this.sectionDrafts.set(section, value);
    }

    /**
     * Returns the current draft for a section, or `null` when none is stored.
     *
     * @param section - Section key to query.
     * @returns The stored draft, or `null`.
     *
     * @example
     * ctrl.getSectionDraft('title'); // null (before setSectionDraft)
     */
    getSectionDraft(section: SectionKey): SectionDraft | null {
        return this.sectionDrafts.get(section) ?? null;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Clears all section editing state and drafts.
     *
     * Safe to call multiple times.
     *
     * @returns `void`
     *
     * @example
     * ctrl.dispose();
     */
    dispose(): void {
        this.editingSections.clear();
        this.sectionDrafts.clear();
    }
}
