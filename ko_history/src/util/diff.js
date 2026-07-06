/*
 * Minimal line-diff for the KO History source-diff tab.
 * - prettyXml(): make compact dashboard XML diffable (newline between tags,
 *   and pretty-print the JSON inside a Dashboard Studio <definition> CDATA).
 * - lineDiff(): LCS line diff → ops [{t:'eq'|'add'|'del', line}].
 *
 * lineDiff delegates to the shared engine (prefix/suffix trim, Int32Array,
 * graceful block-replace degradation). See src/shared/lineDiff.js.
 */

// eslint-disable-next-line import/no-commonjs
const lineDiffCore = require('../shared/lineDiff.js');

function prettyXml(xml) {
    if (!xml) return '';
    let s = String(xml);
    // Pretty-print the Studio definition JSON so structural changes diff per-line.
    s = s.replace(/(<definition>\s*<!\[CDATA\[)([\s\S]*?)(\]\]>\s*<\/definition>)/, (m, a, json, c) => {
        try {
            return a + '\n' + JSON.stringify(JSON.parse(json), null, 2) + '\n' + c;
        } catch (e) {
            return m;
        }
    });
    // Break between adjacent tags so Simple XML diffs line-by-line.
    s = s.replace(/>\s*</g, '>\n<');
    return s;
}

export function toLines(xml) {
    return prettyXml(xml).split('\n');
}

// LCS line diff. Returns ops [{t:'eq'|'add'|'del', line}] where line is a string.
export function lineDiff(aLines, bLines) {
    const a = aLines || [];
    const b = bLines || [];
    const result = lineDiffCore(a, b);
    const ops = [];
    for (let i = 0; i < result.ops.length; i++) {
        const op = result.ops[i];
        if (op.t === 'eq')       ops.push({ t: 'eq',  line: op.a });
        else if (op.t === 'del') ops.push({ t: 'del', line: op.a });
        else                     ops.push({ t: 'add', line: op.b });
    }
    return ops;
}
