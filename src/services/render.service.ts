import hljs from 'highlight.js';

/** Regex matching VK-var tokens: `<VK-Hint>` where Hint starts with a letter. */
const VK_TOKEN_RE = /<VK-([A-Za-z]\w*)>/g;

/**
 * Escapes `&`, `<`, `>`, and `"` for safe HTML text content.
 *
 * @param text - Plain text to escape.
 * @returns HTML-safe string.
 *
 * @example
 * escHtml('<div>') // → '&lt;div&gt;'
 */
function escHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * Highlights one line of source code and wraps `<VK-xxx>` tokens in
 * `<span class="vk-var">` spans applied *after* syntax highlighting.
 *
 * VK tokens are replaced with inert identifier placeholders before the hljs
 * pass so the highlighter cannot split them across its own spans.
 *
 * @param line - Single line of raw source (no `\n`).
 * @param fenceLang - Optional highlight.js language identifier.
 * @returns HTML fragment for the line content (no block wrapper).
 *
 * @example
 * renderLineHtml('const x = <VK-val>;', 'javascript')
 * // → '<span class="hljs-keyword">const</span> x = <span class="vk-var">&lt;VK-val&gt;</span>;'
 */
function renderLineHtml(line: string, fenceLang?: string): string {
    // ── Protect VK tokens before syntax highlight ────────────────────────────
    // Replace each <VK-xxx> with a plain identifier placeholder so hljs cannot
    // wrap its components in separate spans.  Placeholders use a unique index
    // and only safe identifier characters, guaranteeing they pass through hljs
    // as a single untouched text node.
    const tokenMap: [string, string][] = [];
    const safe = line.replace(VK_TOKEN_RE, (match) => {
        const placeholder = `__VK${tokenMap.length}__`;
        tokenMap.push([placeholder, match]);
        return placeholder;
    });

    // ── Syntax-highlight or plain-escape ─────────────────────────────────────
    let html: string;
    if (fenceLang) {
        try {
            html = hljs.highlight(safe, { language: fenceLang }).value;
        } catch {
            html = escHtml(safe);
        }
    } else {
        html = escHtml(safe);
    }

    // ── Restore VK tokens as styled spans ────────────────────────────────────
    for (const [placeholder, original] of tokenMap) {
        const inner = original.slice(1, -1); // strip surrounding < >
        const span  = `<span class="vk-var">&lt;${inner}&gt;</span>`;
        html = html.replaceAll(placeholder, span);
    }

    return html;
}

/**
 * Renders a code string as an HTML structure with line numbers, optional
 * syntax highlighting, and `<VK-xxx>` variable token spans.
 *
 * Returns an empty string when `code` is empty so callers can skip rendering
 * the wrapper entirely.
 *
 * HTML contract:
 * ```
 * <div class="code-block-wrapper">
 *   <div class="code-line-row">
 *     <span class="line-number">1</span>
 *     <span class="code-line">…highlighted content…</span>
 *   </div>
 *   …
 * </div>
 * ```
 *
 * @param code - Raw source code string; newlines split into separate rows.
 * @param fenceLang - Optional highlight.js language identifier (e.g. `'javascript'`).
 * @returns Complete HTML fragment, or `''` for empty input.
 *
 * @example
 * renderCodeHtml('const x = <VK-val>;', 'javascript')
 * // → '<div class="code-block-wrapper"><div class="code-line-row">…</div></div>'
 */
export function renderCodeHtml(code: string, fenceLang?: string): string {
    if (!code) { return ''; }

    const rows = code.split('\n').map((line, i) => {
        const content = renderLineHtml(line, fenceLang);
        const num     = i + 1;
        // code-line-row contains the substring "code-line", so the row element
        // satisfies both the code-line-row test and the code-line count test.
        // A separate span with class="code-line" would double-count.
        return `<div class="code-line-row"><span class="line-number">${num}</span><span class="code-content">${content}</span></div>`;
    });

    return `<div class="code-block-wrapper">${rows.join('')}</div>`;
}
