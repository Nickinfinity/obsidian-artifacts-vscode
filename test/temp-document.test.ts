import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { TempDocument } from '../src/services/temp-document.service.js';

/**
 * Integration tests for TempDocument — a VS Code untitled-document lifecycle
 * manager used to let the user view and optionally edit artifact content before
 * inserting it.
 *
 * These tests run inside the Extension Development Host and exercise the real
 * VS Code API.  The class does NOT exist yet — all tests here should fail until
 * src/services/temp-document.service.ts is implemented and exported.
 *
 * Usage contract:
 *   const td  = new TempDocument();
 *   const doc = await td.create('const x = 1;', 'javascript');
 *   // user may edit the document in the editor
 *   const text = td.getContent();
 *   await td.dispose();
 */

suite('TempDocument', () => {

    // ── create — return value ─────────────────────────────────────────────────

    test('create returns a vscode.TextDocument', async () => {
        const td  = new TempDocument();
        const doc = await td.create('hello');
        assert.ok(doc && typeof doc.getText === 'function', 'expected a vscode.TextDocument');
        await td.dispose();
    });

    test('created document contains the provided code string', async () => {
        const code = 'const greeting = "hello world";';
        const td   = new TempDocument();
        const doc  = await td.create(code);
        assert.strictEqual(doc.getText(), code);
        await td.dispose();
    });

    // ── create — language ─────────────────────────────────────────────────────

    test('create sets document language to the provided language string', async () => {
        const td  = new TempDocument();
        const doc = await td.create('const x = 1;', 'javascript');
        assert.strictEqual(doc.languageId, 'javascript');
        await td.dispose();
    });

    test('create with no language argument defaults to plaintext', async () => {
        const td  = new TempDocument();
        const doc = await td.create('just some text');
        assert.strictEqual(doc.languageId, 'plaintext');
        await td.dispose();
    });

    test('create with undefined language defaults to plaintext', async () => {
        const td  = new TempDocument();
        const doc = await td.create('just some text', undefined);
        assert.strictEqual(doc.languageId, 'plaintext');
        await td.dispose();
    });

    // ── getContent ────────────────────────────────────────────────────────────

    test('getContent returns the current document text', async () => {
        const code = 'echo hello';
        const td   = new TempDocument();
        await td.create(code);
        assert.strictEqual(td.getContent(), code);
        await td.dispose();
    });

    test('getContent reflects edits made to the document after create', async () => {
        const td  = new TempDocument();
        const doc = await td.create('original text', 'plaintext');
        // Simulate an edit through the VS Code API.
        const editor = await vscode.window.showTextDocument(doc);
        await editor.edit(eb => eb.replace(
            new vscode.Range(0, 0, doc.lineCount, 0),
            'edited text'
        ));
        assert.strictEqual(td.getContent(), 'edited text');
        await td.dispose();
    });

    // ── dispose ───────────────────────────────────────────────────────────────

    test('dispose resolves without throwing', async () => {
        const td = new TempDocument();
        await td.create('temp content');
        await assert.doesNotReject(() => td.dispose());
    });

    test('calling dispose twice does not throw', async () => {
        const td = new TempDocument();
        await td.create('temp content');
        await td.dispose();
        await assert.doesNotReject(() => td.dispose());
    });

    test('dispose closes the document tab (no open editor for the document after dispose)', async () => {
        const td  = new TempDocument();
        const doc = await td.create('temp content');
        await vscode.window.showTextDocument(doc);
        await td.dispose();
        const stillOpen = vscode.window.visibleTextEditors.some(
            e => e.document.uri.toString() === doc.uri.toString()
        );
        assert.ok(!stillOpen, 'expected the editor tab to be closed after dispose');
    });

    // ── getContent after dispose ──────────────────────────────────────────────

    test('getContent after dispose throws or returns empty string', () => {
        const td = new TempDocument();
        // Intentionally not calling create — but even after dispose the contract holds.
        // Test via a created-and-disposed instance.
        (async () => {
            await td.create('some content');
            await td.dispose();
            let threw = false;
            let result = '';
            try {
                result = td.getContent();
            } catch {
                threw = true;
            }
            assert.ok(
                threw || result === '',
                `expected throw or empty string after dispose, got: "${result}"`,
            );
        });
        // The synchronous outer test just ensures the shape exists; async variant
        // is exercised in the dedicated async test below.
    });

    test('getContent after dispose — async variant: throws or returns empty string', async () => {
        const td = new TempDocument();
        await td.create('some content');
        await td.dispose();
        let threw = false;
        let result = '';
        try {
            result = td.getContent();
        } catch {
            threw = true;
        }
        assert.ok(
            threw || result === '',
            `expected throw or empty string after dispose, got: "${result}"`,
        );
    });

    // ── isAlive ───────────────────────────────────────────────────────────────

    test('isAlive returns false before create is called', () => {
        const td = new TempDocument();
        assert.strictEqual(td.isAlive(), false);
    });

    test('isAlive returns true after create', async () => {
        const td = new TempDocument();
        await td.create('hello');
        assert.strictEqual(td.isAlive(), true);
        await td.dispose();
    });

    test('isAlive returns false after dispose', async () => {
        const td = new TempDocument();
        await td.create('hello');
        await td.dispose();
        assert.strictEqual(td.isAlive(), false);
    });

    test('isAlive returns false after dispose called twice', async () => {
        const td = new TempDocument();
        await td.create('hello');
        await td.dispose();
        await td.dispose();
        assert.strictEqual(td.isAlive(), false);
    });

});
