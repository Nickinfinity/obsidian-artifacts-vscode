import * as assert from 'node:assert';
import { patchFrontmatterField, patchVarDefaults } from '../src/services/artifact-patcher.service.js';

/**
 * Unit tests for the artifact-patcher service.
 *
 * Both functions operate on raw .md file content strings and return the updated
 * content string.  The service does NOT exist yet — all tests here should fail
 * until src/services/artifact-patcher.service.ts is implemented and exported.
 *
 * Usage contract:
 *   patchFrontmatterField(content, 'title', 'New Title')  → updated content
 *   patchVarDefaults(content, { 'VK-host': 'localhost' }) → updated content
 */

// ── patchFrontmatterField ─────────────────────────────────────────────────────

suite('patchFrontmatterField', () => {

    // ── Update existing fields ────────────────────────────────────────────────

    test('updates existing title field and leaves all other fields unchanged', () => {
        const content = [
            '---',
            'type: snippet',
            'title: Old Title',
            'description: Some description',
            '---',
            '',
            '```code',
            'const x = 1;',
            '```',
        ].join('\n');

        const result = patchFrontmatterField(content, 'title', 'New Title');

        const expected = [
            '---',
            'type: snippet',
            'title: New Title',
            'description: Some description',
            '---',
            '',
            '```code',
            'const x = 1;',
            '```',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    test('updates existing description field and leaves all other fields unchanged', () => {
        const content = [
            '---',
            'type: template',
            'title: My Template',
            'description: Original description',
            'language: typescript',
            '---',
        ].join('\n');

        const result = patchFrontmatterField(content, 'description', 'Updated description');

        const expected = [
            '---',
            'type: template',
            'title: My Template',
            'description: Updated description',
            'language: typescript',
            '---',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── Inserting a missing field ─────────────────────────────────────────────

    test('inserts a new field before the closing --- when the field does not exist', () => {
        const content = [
            '---',
            'type: snippet',
            'title: My Snippet',
            '---',
        ].join('\n');

        const result = patchFrontmatterField(content, 'language', 'python');

        const expected = [
            '---',
            'type: snippet',
            'title: My Snippet',
            'language: python',
            '---',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── Field order preservation ──────────────────────────────────────────────

    test('multi-field frontmatter retains all other fields in their original order', () => {
        const content = [
            '---',
            'type: command',
            'title: Deploy',
            'description: Deploy to production',
            'language: bash',
            'tags: [deploy, prod]',
            'env: production',
            'target: terminal',
            '---',
        ].join('\n');

        const result = patchFrontmatterField(content, 'title', 'Deploy to Prod');

        const expected = [
            '---',
            'type: command',
            'title: Deploy to Prod',
            'description: Deploy to production',
            'language: bash',
            'tags: [deploy, prod]',
            'env: production',
            'target: terminal',
            '---',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── Special characters in values ──────────────────────────────────────────

    test('value containing a colon is wrapped in double quotes', () => {
        const content = [
            '---',
            'type: snippet',
            'title: My Snippet',
            '---',
        ].join('\n');

        const result = patchFrontmatterField(content, 'title', 'https://example.com');

        const expected = [
            '---',
            'type: snippet',
            'title: "https://example.com"',
            '---',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    test('value containing double quotes is wrapped in single quotes', () => {
        const content = [
            '---',
            'type: snippet',
            'description: Original',
            '---',
        ].join('\n');

        const result = patchFrontmatterField(content, 'description', 'He said "hello world"');

        const expected = [
            '---',
            'type: snippet',
            'description: \'He said "hello world"\'',
            '---',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── No frontmatter ────────────────────────────────────────────────────────

    test('file with no frontmatter fences is returned unchanged', () => {
        const content = [
            '# Just a heading',
            '',
            'Some plain text with no YAML frontmatter.',
        ].join('\n');

        const result = patchFrontmatterField(content, 'title', 'Anything');

        assert.strictEqual(result, content);
    });

    test('file whose content does not start with --- is returned unchanged', () => {
        const content = [
            '```code',
            'const x = 1;',
            '```',
        ].join('\n');

        const result = patchFrontmatterField(content, 'type', 'snippet');

        assert.strictEqual(result, content);
    });
});

// ── patchVarDefaults ──────────────────────────────────────────────────────────

suite('patchVarDefaults', () => {

    // ── Existing vars section ─────────────────────────────────────────────────

    test('updates values for var names that exist in the defaults map', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'SELECT * FROM <VK-table> WHERE id = <VK-id>;',
            '```',
            '',
            'vars:',
            'VK-table=orders',
            'VK-id=',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-table': 'products', 'VK-id': '42' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'SELECT * FROM <VK-table> WHERE id = <VK-id>;',
            '```',
            '',
            'vars:',
            'VK-table=products',
            'VK-id=42',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    test('appends new var lines for names not already in the vars section', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'echo <VK-message>',
            '```',
            '',
            'vars:',
            'VK-message=hello',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-message': 'world', 'VK-count': '3' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'echo <VK-message>',
            '```',
            '',
            'vars:',
            'VK-message=world',
            'VK-count=3',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    test('vars not present in the defaults map are preserved unchanged', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'curl <VK-host>:<VK-port>/<VK-path>',
            '```',
            '',
            'vars:',
            'VK-host=localhost',
            'VK-port=3000',
            'VK-path=api',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-host': 'example.com' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'curl <VK-host>:<VK-port>/<VK-path>',
            '```',
            '',
            'vars:',
            'VK-host=example.com',
            'VK-port=3000',
            'VK-path=api',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── No existing vars section ──────────────────────────────────────────────

    test('appends a vars: section after the last code fence when no vars section exists', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'echo <VK-message>',
            '```',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-message': 'hello' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'echo <VK-message>',
            '```',
            '',
            'vars:',
            'VK-message=hello',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── Empty defaults map ────────────────────────────────────────────────────

    test('empty defaults map returns content unchanged', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'const x = <VK-value>;',
            '```',
            '',
            'vars:',
            'VK-value=default',
        ].join('\n');

        const result = patchVarDefaults(content, {});

        assert.strictEqual(result, content);
    });

    test('empty defaults map on a file with no vars section also returns content unchanged', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'const x = 1;',
            '```',
        ].join('\n');

        const result = patchVarDefaults(content, {});

        assert.strictEqual(result, content);
    });

    // ── Multi-block files ─────────────────────────────────────────────────────

    test('multi-block file with no vars section appends vars after the final code fence', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '## Development',
            '```bash',
            'http://localhost:<VK-port>',
            '```',
            '',
            '## Production',
            '```bash',
            'https://<VK-host>/api',
            '```',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-port': '3000', 'VK-host': 'example.com' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '## Development',
            '```bash',
            'http://localhost:<VK-port>',
            '```',
            '',
            '## Production',
            '```bash',
            'https://<VK-host>/api',
            '```',
            '',
            'vars:',
            'VK-port=3000',
            'VK-host=example.com',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    test('multi-block file with an existing vars section updates that section in place', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '## Development',
            '```bash',
            'http://localhost:<VK-port>',
            '```',
            '',
            '## Production',
            '```bash',
            'https://<VK-host>/api',
            '```',
            '',
            'vars:',
            'VK-port=8080',
            'VK-host=staging.example.com',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-port': '3000', 'VK-host': 'prod.example.com' });

        const expected = [
            '---',
            'type: snippet',
            '---',
            '',
            '## Development',
            '```bash',
            'http://localhost:<VK-port>',
            '```',
            '',
            '## Production',
            '```bash',
            'https://<VK-host>/api',
            '```',
            '',
            'vars:',
            'VK-port=3000',
            'VK-host=prod.example.com',
        ].join('\n');

        assert.strictEqual(result, expected);
    });

    // ── VK- prefix ────────────────────────────────────────────────────────────

    test('key VK-items in defaults map produces line VK-items=products in output', () => {
        const content = [
            '---',
            'type: snippet',
            '---',
            '',
            '```code',
            'SELECT * FROM <VK-items>;',
            '```',
        ].join('\n');

        const result = patchVarDefaults(content, { 'VK-items': 'products' });

        assert.ok(
            result.includes('VK-items=products'),
            `expected output to contain "VK-items=products", got:\n${result}`,
        );
    });
});
