import * as assert from 'node:assert';
import type { ParsedVar } from '../src/types/parsed-artifact.types.js';
import type { ApplyChange, ApplyResult } from '../src/types/varset.types.js';
import { applyVarSet } from '../src/services/varset.service.js';

/**
 * Unit tests for applyVarSet — pure merge of a variable set's defaults on top
 * of the user's current input values, producing both the final value map and a
 * per-var change log.
 *
 * Signature:
 *   applyVarSet(currentValues: Record<string, string>, setVars: ParsedVar[]): ApplyResult
 *
 * ApplyResult: { values: Record<string, string>, changes: ApplyChange[] }
 * ApplyChange: { name, oldValue, newValue, action: 'filled' | 'overridden' | 'kept' }
 *
 * The function does NOT exist yet — all tests should fail until
 * src/services/varset.service.ts implements `applyVarSet`.
 */

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a `ParsedVar[]` from a `name → defaultValue` map.
 *
 * @param obj - Plain object whose keys are full var names and values are defaults.
 * @returns Ordered `ParsedVar[]`.
 *
 * @example
 * mkSetVars({ 'VK-host': 'localhost', 'VK-port': '3000' })
 */
function mkSetVars(obj: Record<string, string>): ParsedVar[] {
    return Object.entries(obj).map(([name, defaultValue]) => ({ name, defaultValue }));
}

/**
 * Locates a single change row by var name. Throws when missing or duplicated
 * so the caller does not silently consume a wrong row.
 *
 * @param changes - Array of `ApplyChange` from an `ApplyResult`.
 * @param name    - Full var name to locate.
 * @returns The unique `ApplyChange` for `name`.
 *
 * @example
 * findChange(result.changes, 'VK-host')
 */
function findChange(changes: ApplyChange[], name: string): ApplyChange {
    const matches = changes.filter(c => c.name === name);
    assert.strictEqual(matches.length, 1, `expected exactly one change for ${name}, got ${matches.length}`);
    return matches[0];
}

// ── Test suite ────────────────────────────────────────────────────────────────

suite('applyVarSet', () => {

    // ── Filling empty current values ──────────────────────────────────────────

    test('empty current values + set provides values → all marked "filled"', () => {
        const result: ApplyResult = applyVarSet(
            {},
            mkSetVars({ 'VK-host': 'localhost', 'VK-port': '3000' }),
        );

        assert.strictEqual(result.changes.length, 2);
        assert.ok(result.changes.every(c => c.action === 'filled'));
        assert.deepStrictEqual(result.values, { 'VK-host': 'localhost', 'VK-port': '3000' });
    });

    test('filled change row carries oldValue: "" and newValue from set', () => {
        const result = applyVarSet({}, mkSetVars({ 'VK-x': 'val' }));
        const change = findChange(result.changes, 'VK-x');
        assert.strictEqual(change.oldValue, '');
        assert.strictEqual(change.newValue, 'val');
        assert.strictEqual(change.action,   'filled');
    });

    // ── Override path ─────────────────────────────────────────────────────────

    test('current values exist + set provides same keys → marked "overridden", new value wins', () => {
        const result = applyVarSet(
            { 'VK-host': 'old.example.com', 'VK-port': '8080' },
            mkSetVars({ 'VK-host': 'new.example.com', 'VK-port': '3000' }),
        );

        const hostChange = findChange(result.changes, 'VK-host');
        const portChange = findChange(result.changes, 'VK-port');
        assert.strictEqual(hostChange.action,   'overridden');
        assert.strictEqual(hostChange.oldValue, 'old.example.com');
        assert.strictEqual(hostChange.newValue, 'new.example.com');
        assert.strictEqual(portChange.action,   'overridden');
        assert.strictEqual(portChange.oldValue, '8080');
        assert.strictEqual(portChange.newValue, '3000');

        assert.deepStrictEqual(result.values, { 'VK-host': 'new.example.com', 'VK-port': '3000' });
    });

    // ── Kept path ─────────────────────────────────────────────────────────────

    test('current values exist + set does NOT provide key → marked "kept", old value preserved', () => {
        const result = applyVarSet(
            { 'VK-keep': 'preserved' },
            mkSetVars({ 'VK-other': 'unrelated' }),
        );

        const keepChange = findChange(result.changes, 'VK-keep');
        assert.strictEqual(keepChange.action,   'kept');
        assert.strictEqual(keepChange.oldValue, 'preserved');
        assert.strictEqual(keepChange.newValue, 'preserved');
        assert.strictEqual(result.values['VK-keep'], 'preserved');
    });

    // ── Mix of filled, overridden, and kept ───────────────────────────────────

    test('mix of filled, overridden, and kept in one call', () => {
        const result = applyVarSet(
            { 'VK-keep': 'stay', 'VK-override': 'old' },
            mkSetVars({ 'VK-override': 'new', 'VK-fill': 'fresh' }),
        );

        const keepChange = findChange(result.changes, 'VK-keep');
        const overChange = findChange(result.changes, 'VK-override');
        const fillChange = findChange(result.changes, 'VK-fill');

        assert.strictEqual(keepChange.action, 'kept');
        assert.strictEqual(overChange.action, 'overridden');
        assert.strictEqual(fillChange.action, 'filled');

        assert.deepStrictEqual(result.values, {
            'VK-keep':     'stay',
            'VK-override': 'new',
            'VK-fill':     'fresh',
        });
        assert.strictEqual(result.changes.length, 3);
    });

    // ── Stacking sets ─────────────────────────────────────────────────────────

    test('applying a second set after a first — overlapping vars override, non-overlapping from first stay', () => {
        // First apply.
        const first = applyVarSet({}, mkSetVars({
            'VK-host': 'first-host',
            'VK-port': '8080',
            'VK-only-in-first': 'one',
        }));
        assert.deepStrictEqual(first.values, {
            'VK-host':          'first-host',
            'VK-port':          '8080',
            'VK-only-in-first': 'one',
        });

        // Second apply on top of the first result.
        const second = applyVarSet(first.values, mkSetVars({
            'VK-host': 'second-host',
            'VK-new':  'fresh',
        }));

        assert.deepStrictEqual(second.values, {
            'VK-host':          'second-host',  // overridden
            'VK-port':          '8080',         // kept
            'VK-only-in-first': 'one',          // kept
            'VK-new':           'fresh',        // filled
        });

        assert.strictEqual(findChange(second.changes, 'VK-host').action,          'overridden');
        assert.strictEqual(findChange(second.changes, 'VK-port').action,          'kept');
        assert.strictEqual(findChange(second.changes, 'VK-only-in-first').action, 'kept');
        assert.strictEqual(findChange(second.changes, 'VK-new').action,           'filled');
    });

    // ── Empty defaultValue ────────────────────────────────────────────────────

    test('set var with empty defaultValue → fills with empty string, still marked "filled"', () => {
        const result = applyVarSet({}, mkSetVars({ 'VK-x': '' }));
        const change = findChange(result.changes, 'VK-x');

        assert.strictEqual(change.action,   'filled');
        assert.strictEqual(change.oldValue, '');
        assert.strictEqual(change.newValue, '');
        assert.strictEqual(result.values['VK-x'], '');
    });

    test('set var with empty defaultValue overriding existing non-empty → "overridden" with empty newValue', () => {
        const result = applyVarSet({ 'VK-x': 'previous' }, mkSetVars({ 'VK-x': '' }));
        const change = findChange(result.changes, 'VK-x');

        assert.strictEqual(change.action,   'overridden');
        assert.strictEqual(change.oldValue, 'previous');
        assert.strictEqual(change.newValue, '');
        assert.strictEqual(result.values['VK-x'], '');
    });

    // ── Final values shape ────────────────────────────────────────────────────

    test('values in result is the merged final state of every var in the union', () => {
        const result = applyVarSet(
            { 'VK-a': 'A', 'VK-b': 'B' },
            mkSetVars({ 'VK-b': 'B-NEW', 'VK-c': 'C' }),
        );
        assert.deepStrictEqual(result.values, {
            'VK-a': 'A',
            'VK-b': 'B-NEW',
            'VK-c': 'C',
        });
    });

    // ── Changes-array shape ───────────────────────────────────────────────────

    test('changes array has one entry per var in the union of current + set keys', () => {
        const result = applyVarSet(
            { 'VK-a': '1', 'VK-b': '2' },
            mkSetVars({ 'VK-b': 'two', 'VK-c': '3' }),
        );
        const names = result.changes.map(c => c.name).sort();
        assert.deepStrictEqual(names, ['VK-a', 'VK-b', 'VK-c']);
    });

    test('no duplicate change rows for vars that appear in both current and set', () => {
        const result = applyVarSet(
            { 'VK-x': 'old' },
            mkSetVars({ 'VK-x': 'new' }),
        );
        const xChanges = result.changes.filter(c => c.name === 'VK-x');
        assert.strictEqual(xChanges.length, 1);
        assert.strictEqual(xChanges[0].action, 'overridden');
    });

    // ── Both inputs empty ─────────────────────────────────────────────────────

    test('empty current values + empty set → empty values map and empty changes array', () => {
        const result = applyVarSet({}, []);
        assert.deepStrictEqual(result.values,  {});
        assert.deepStrictEqual(result.changes, []);
    });

    // ── Purity ────────────────────────────────────────────────────────────────

    test('does not mutate the input currentValues object', () => {
        const current = { 'VK-x': 'orig' };
        const before  = { ...current };
        applyVarSet(current, mkSetVars({ 'VK-x': 'changed', 'VK-new': 'fresh' }));
        assert.deepStrictEqual(current, before);
    });

    test('does not mutate the input setVars array', () => {
        const setVars = mkSetVars({ 'VK-x': 'val' });
        const snapshot = setVars.map(v => ({ ...v }));
        applyVarSet({}, setVars);
        assert.deepStrictEqual(setVars, snapshot);
    });

});
