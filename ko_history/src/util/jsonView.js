/*
 * jsonView — pure line-model builder for KO source (JSON / Simple XML / DS XML).
 *
 * The detect/jsonLines/xmlLines engine is shared with the bundled
 * `ko_history.json_viewer` custom viz via ko_history/src/shared/sourceLines.js.
 * Both feed innerHTML — an escaping fix in one used to leave the other
 * exploitable. Now one shared module owns the engine.
 *
 * buildView(raw, indent) returns:
 *   { kind, label, lines, pretty, depth, ok, foldGroups, maxDepth }
 * where each line is { indent, html, fold, foldEnd, summary } and the html holds
 * pre-escaped <span class="kojv__*"> token markup (rendered via dangerouslySetInnerHTML).
 */

// eslint-disable-next-line import/no-commonjs
const _sl = require('../shared/sourceLines.js');

const escHtml = _sl.escHtml;

function stripTags(html) {
    return String(html).replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function maxIndent(lines) {
    let m = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i].indent > m) m = lines[i].indent;
    return m;
}

function jsonDepth(v) {
    if (!v || typeof v !== 'object') return 0;
    let max = 0;
    for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) {
        const d = jsonDepth(v[k]); if (d > max) max = d;
    }
    return max + 1;
}

// foldGroups: fid -> { fold, depth, start, end }; built from foldable lines.
function buildFoldGroups(lines) {
    const groups = {};
    let maxDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        if (L.fold && L.foldEnd > i) {
            groups[L.fold] = { fold: L.fold, depth: L.indent, start: i, end: L.foldEnd };
            if (L.indent > maxDepth) maxDepth = L.indent;
        }
    }
    return { foldGroups: groups, maxDepth };
}

// Main entry: raw source string + indent → renderable view model.
export function buildView(raw, indent) {
    indent = Math.max(1, Math.min(8, parseInt(indent, 10) || 2));
    let det = _sl.detect(raw);
    let lines, pretty, depth, ok;

    if (det.kind === 'json') {
        try {
            const obj = JSON.parse(det.text);
            lines = _sl.jsonLines(obj, indent);
            pretty = JSON.stringify(obj, null, indent);
            depth = jsonDepth(obj);
            ok = 'valid JSON';
        } catch (e) {
            det = { kind: 'raw', label: det.label === 'Raw' ? 'Raw' : 'Unparsed', text: det.text };
        }
    }
    if (det.kind === 'xml') {
        lines = _sl.xmlLines(det.text, indent);
        pretty = lines.map((l) => stripTags(l.html)).join('\n');
        depth = maxIndent(lines);
        ok = 'well-formed XML';
    }
    if (det.kind === 'raw') {
        const rawStr = String(raw == null ? '' : raw);
        lines = rawStr.split('\n').map((ln) => ({
            indent: 0, html: '<span class="kojv__s">' + escHtml(ln) + '</span>', fold: null,
        }));
        pretty = rawStr;
        depth = 0;
        ok = det.label === 'Unparsed' ? 'unparsed' : 'raw text';
    }

    const { foldGroups, maxDepth } = buildFoldGroups(lines);
    return { kind: det.kind, label: det.label, lines, pretty, depth, ok, foldGroups, maxDepth };
}
