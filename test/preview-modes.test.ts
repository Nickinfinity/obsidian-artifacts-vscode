import * as assert from 'node:assert';
import { PreviewModeController } from '../src/services/preview-mode.service.js';

/**
 * Unit tests for PreviewModeController — manages mode transitions and per-section
 * editing state for the artifact preview/edit panel.
 *
 * The class does NOT exist yet — all tests here should fail until
 * src/services/preview-mode.service.ts is implemented and exported.
 *
 * Usage contract:
 *   const ctrl = new PreviewModeController('const x = 1;');
 *   ctrl.enterQuickEdit();
 *   ctrl.setSectionDraft('title', 'New Title');
 *   ctrl.stopEditingSection('title');
 *   await ctrl.dispose();
 */

// ── Mode state ────────────────────────────────────────────────────────────────

suite('PreviewModeController — mode state', () => {

    // ── Initial state ─────────────────────────────────────────────────────────

    test('initial mode is preview', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        assert.strictEqual(ctrl.mode, 'preview');
    });

    // ── preview ↔ quickEdit ───────────────────────────────────────────────────

    test('enterQuickEdit transitions from preview to quickEdit', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterQuickEdit();
        assert.strictEqual(ctrl.mode, 'quickEdit');
    });

    test('enterPreview transitions from quickEdit back to preview', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterQuickEdit();
        ctrl.enterPreview();
        assert.strictEqual(ctrl.mode, 'preview');
    });

    // ── preview ↔ fullEdit ────────────────────────────────────────────────────

    test('enterFullEdit transitions from preview to fullEdit', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterFullEdit();
        assert.strictEqual(ctrl.mode, 'fullEdit');
    });

    test('enterPreview transitions from fullEdit back to preview', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterFullEdit();
        ctrl.enterPreview();
        assert.strictEqual(ctrl.mode, 'preview');
    });

    test('enterPreview from preview is a no-op — mode stays preview', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterPreview();
        assert.strictEqual(ctrl.mode, 'preview');
    });

    // ── Invalid transition: quickEdit → fullEdit ──────────────────────────────

    test('enterFullEdit while in quickEdit throws or leaves mode as quickEdit', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterQuickEdit();
        let threw = false;
        try {
            ctrl.enterFullEdit();
        } catch {
            threw = true;
        }
        assert.ok(
            threw || ctrl.mode === 'quickEdit',
            `expected throw or mode to stay "quickEdit", got mode="${ctrl.mode}"`,
        );
    });

    // ── getInsertableCode ─────────────────────────────────────────────────────

    test('getInsertableCode returns the original code in preview mode', () => {
        const code = 'const x = 1;';
        const ctrl = new PreviewModeController(code);
        assert.strictEqual(ctrl.getInsertableCode(), code);
    });

    test('getInsertableCode returns the original code before any edits in quickEdit mode', () => {
        const code = 'const x = 1;';
        const ctrl = new PreviewModeController(code);
        ctrl.enterQuickEdit();
        assert.strictEqual(ctrl.getInsertableCode(), code);
    });

    test('getInsertableCode returns the edited code after setEditedCode in quickEdit mode', () => {
        const ctrl = new PreviewModeController('const x = 1;');
        ctrl.enterQuickEdit();
        ctrl.setEditedCode('const x = 42;');
        assert.strictEqual(ctrl.getInsertableCode(), 'const x = 42;');
    });

    test('getInsertableCode returns original after transitioning back to preview', () => {
        const original = 'const x = 1;';
        const ctrl     = new PreviewModeController(original);
        ctrl.enterQuickEdit();
        ctrl.setEditedCode('const x = 99;');
        ctrl.enterPreview();
        assert.strictEqual(ctrl.getInsertableCode(), original);
    });
});

// ── Section editing state ─────────────────────────────────────────────────────

suite('PreviewModeController — section editing state', () => {

    // ── isEditingSection ──────────────────────────────────────────────────────

    test('isEditingSection returns false for all sections before any startEditingSection call', () => {
        const ctrl = new PreviewModeController('');
        assert.strictEqual(ctrl.isEditingSection('title'),       false);
        assert.strictEqual(ctrl.isEditingSection('description'), false);
        assert.strictEqual(ctrl.isEditingSection('varDefaults'), false);
    });

    test('startEditingSection marks the section as editing', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        assert.strictEqual(ctrl.isEditingSection('title'), true);
    });

    test('startEditingSection for one section does not affect others', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('description');
        assert.strictEqual(ctrl.isEditingSection('title'),       false);
        assert.strictEqual(ctrl.isEditingSection('varDefaults'), false);
    });

    test('multiple sections can be in edit state simultaneously', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('description');
        assert.strictEqual(ctrl.isEditingSection('title'),       true);
        assert.strictEqual(ctrl.isEditingSection('description'), true);
        assert.strictEqual(ctrl.isEditingSection('varDefaults'), false);
    });

    test('stopEditingSection marks the section as no longer editing', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.stopEditingSection('title');
        assert.strictEqual(ctrl.isEditingSection('title'), false);
    });

    test('stopEditingSection for one section does not affect other editing sections', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('description');
        ctrl.stopEditingSection('title');
        assert.strictEqual(ctrl.isEditingSection('description'), true);
    });

    test('stopEditingSection on a section that is not editing is a no-op', () => {
        const ctrl = new PreviewModeController('');
        assert.doesNotThrow(() => ctrl.stopEditingSection('varDefaults'));
        assert.strictEqual(ctrl.isEditingSection('varDefaults'), false);
    });

    // ── getSectionDraft / setSectionDraft ─────────────────────────────────────

    test('getSectionDraft returns null before any draft is set', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        assert.strictEqual(ctrl.getSectionDraft('title'), null);
    });

    test('getSectionDraft returns null for a section that is not being edited', () => {
        const ctrl = new PreviewModeController('');
        assert.strictEqual(ctrl.getSectionDraft('description'), null);
    });

    test('setSectionDraft stores a string draft for title', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.setSectionDraft('title', 'My New Title');
        assert.strictEqual(ctrl.getSectionDraft('title'), 'My New Title');
    });

    test('setSectionDraft stores a string draft for description', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('description');
        ctrl.setSectionDraft('description', 'Updated description text');
        assert.strictEqual(ctrl.getSectionDraft('description'), 'Updated description text');
    });

    test('setSectionDraft stores a Record draft for varDefaults', () => {
        const ctrl    = new PreviewModeController('');
        const draft   = { 'VK-host': 'localhost', 'VK-port': '3000' };
        ctrl.startEditingSection('varDefaults');
        ctrl.setSectionDraft('varDefaults', draft);
        assert.deepStrictEqual(ctrl.getSectionDraft('varDefaults'), draft);
    });

    test('setSectionDraft for one section does not affect drafts for others', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('description');
        ctrl.setSectionDraft('title', 'Only Title');
        assert.strictEqual(ctrl.getSectionDraft('title'),       'Only Title');
        assert.strictEqual(ctrl.getSectionDraft('description'), null);
    });

    test('setSectionDraft overwrites a previously stored draft', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.setSectionDraft('title', 'First Draft');
        ctrl.setSectionDraft('title', 'Second Draft');
        assert.strictEqual(ctrl.getSectionDraft('title'), 'Second Draft');
    });

    // ── stopEditingSection clears draft ───────────────────────────────────────

    test('stopEditingSection clears the stored draft for that section', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.setSectionDraft('title', 'Draft value');
        ctrl.stopEditingSection('title');
        assert.strictEqual(ctrl.getSectionDraft('title'), null);
    });

    test('stopEditingSection clears the varDefaults draft', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('varDefaults');
        ctrl.setSectionDraft('varDefaults', { 'VK-x': '1' });
        ctrl.stopEditingSection('varDefaults');
        assert.strictEqual(ctrl.getSectionDraft('varDefaults'), null);
    });

    test('stopEditingSection for one section does not clear draft for another', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('description');
        ctrl.setSectionDraft('title',       'Title draft');
        ctrl.setSectionDraft('description', 'Desc draft');
        ctrl.stopEditingSection('title');
        assert.strictEqual(ctrl.getSectionDraft('description'), 'Desc draft');
    });

    // ── dispose ───────────────────────────────────────────────────────────────

    test('dispose clears all section editing states', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('description');
        ctrl.startEditingSection('varDefaults');
        ctrl.dispose();
        assert.strictEqual(ctrl.isEditingSection('title'),       false);
        assert.strictEqual(ctrl.isEditingSection('description'), false);
        assert.strictEqual(ctrl.isEditingSection('varDefaults'), false);
    });

    test('dispose clears all section drafts', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.startEditingSection('varDefaults');
        ctrl.setSectionDraft('title',       'Draft title');
        ctrl.setSectionDraft('varDefaults', { 'VK-x': '1' });
        ctrl.dispose();
        assert.strictEqual(ctrl.getSectionDraft('title'),       null);
        assert.strictEqual(ctrl.getSectionDraft('varDefaults'), null);
    });

    test('dispose can be called multiple times without throwing', () => {
        const ctrl = new PreviewModeController('');
        ctrl.startEditingSection('title');
        ctrl.dispose();
        assert.doesNotThrow(() => ctrl.dispose());
    });
});
