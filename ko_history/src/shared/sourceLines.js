/*
 * sourceLines — shared KO source tokenizer used by the json_viewer custom viz
 * and the React wrapper's SourceView (via src/util/jsonView.js).
 *
 * Exports: detect, jsonLines, xmlLines, esc.
 *
 * detect(raw) → { kind:'json'|'xml'|'raw', label, text }
 * jsonLines(value, indent) → line[]   (value must already be a parsed JS object)
 * xmlLines(src, indent)  → line[]   (src is the raw XML string)
 * esc(s)                 → HTML-escaped string (&amp; &lt; &gt;)
 *
 * Each line object: { indent, html, fold, foldEnd, summary }.
 * html contains pre-escaped <span class="kojv__*"> token markup.
 *
 * ES5 + CommonJS (module.exports) so both the viz AMD bundles and the React
 * ESM wrapper can require it.
 *
 * Divergence notes vs the two original copies
 * ─────────────────────────────────────────────
 * 1. The viz used `esc()` (local name); jsonView.js used `escHtml()` (exported
 *    name). Canonical name here is `esc` (used internally) and also exported as
 *    `escHtml` for the wrapper which imports it under that name.
 * 2. The viz's emit() passed a `parentFold` 4th argument (stored in line.parent)
 *    that jsonView.js omitted (jsonView never stores line.parent). The shared
 *    module omits it — json_viewer never used line.parent for rendering.
 * 3. jsonLines in jsonView.js used an arrow `tok` whereas the viz used a plain
 *    function. Behaviour identical; we use a plain function here (ES5).
 */

(function (factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        (typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {}).sourceLines = factory();
    }
}(function () {

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── format detection ─────────────────────────────────────────────────────
    // Returns { kind: 'json'|'xml'|'raw', label, text }.
    function detect(raw) {
        var s = String(raw == null ? '' : raw);
        var t = s.replace(/^[﻿\s]+/, '');
        // XML-wrapped Studio definition → unwrap to JSON
        var defm = s.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
        if (defm) {
            var inner = defm[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/^\s+/, '');
            if (inner.charAt(0) === '{' || inner.charAt(0) === '[') {
                return { kind: 'json', label: 'Dashboard Studio', text: inner };
            }
        }
        if (t.charAt(0) === '<') {
            var studio = /<dashboard[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
                         /<form[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
                         /<definition\b/i.test(s);
            return { kind: 'xml', label: studio ? 'Dashboard Studio' : 'Simple XML', text: t };
        }
        if (t.charAt(0) === '{' || t.charAt(0) === '[') {
            var studioJson = /"layout"\s*:/.test(t) && /"(visualizations|dataSources)"\s*:/.test(t);
            return { kind: 'json', label: studioJson ? 'Dashboard Studio' : 'JSON', text: t };
        }
        return { kind: 'raw', label: 'Raw', text: s };
    }

    // ── JSON → line model ─────────────────────────────────────────────────────
    // Each line: { indent, html, fold, foldEnd, summary }.
    // foldId set on the opening line of an object/array with >0 children.
    function jsonLines(value, indent) {
        var lines = [];
        var pad = '';
        for (var i = 0; i < indent; i++) pad += ' ';
        var foldSeq = 0;

        function tok(cls, txt) { return '<span class="kojv__' + cls + '">' + esc(txt) + '</span>'; }
        function scalar(v) {
            if (v === null) return tok('b', 'null');
            var ty = typeof v;
            if (ty === 'number') return tok('n', String(v));
            if (ty === 'boolean') return tok('b', String(v));
            return tok('s', JSON.stringify(v)); // string (with quotes + escapes)
        }
        function isObj(v) { return v && typeof v === 'object'; }
        function keysOf(o) {
            var k = []; for (var p in o) if (Object.prototype.hasOwnProperty.call(o, p)) k.push(p); return k;
        }

        function emit(v, prefixHtml, d, trail) {
            var ind = ''; for (var i = 0; i < d; i++) ind += pad;
            if (!isObj(v)) {
                lines.push({ indent: d, html: ind + prefixHtml + scalar(v) + tok('p', trail), fold: null });
                return;
            }
            var isArr = Object.prototype.toString.call(v) === '[object Array]';
            var open = isArr ? '[' : '{';
            var close = isArr ? ']' : '}';
            var items = isArr ? v : keysOf(v);
            if (items.length === 0) {
                lines.push({ indent: d, html: ind + prefixHtml + tok('p', open + close) + tok('p', trail), fold: null });
                return;
            }
            var fid = 'f' + (++foldSeq);
            var summary = isArr
                ? '… ' + items.length + ' item' + (items.length === 1 ? '' : 's')
                : '… ' + items.length + ' key' + (items.length === 1 ? '' : 's');
            var openIdx = lines.push({ indent: d, html: ind + prefixHtml + tok('p', open), fold: fid, summary: summary, foldEnd: -1 }) - 1;
            for (var j = 0; j < items.length; j++) {
                var last = (j === items.length - 1);
                var childTrail = last ? '' : ',';
                if (isArr) {
                    emit(items[j], '', d + 1, childTrail);
                } else {
                    var key = items[j];
                    emit(v[key], tok('k', JSON.stringify(key)) + tok('p', ': '), d + 1, childTrail);
                }
            }
            var indClose = ''; for (var c = 0; c < d; c++) indClose += pad;
            lines.push({ indent: d, html: indClose + tok('p', close) + tok('p', trail), fold: null });
            lines[openIdx].foldEnd = lines.length - 1;
        }
        emit(value, '', 0, '');
        return lines;
    }

    // ── XML → line model ─────────────────────────────────────────────────────
    // Lightweight pretty-printer + tokenizer (no DOM parser → sandbox-safe and
    // tolerant of partial/garbage input). Splits on tags, re-indents by depth,
    // folds elements that contain child elements.
    function xmlLines(src, indent) {
        var pad = ''; for (var i = 0; i < indent; i++) pad += ' ';
        var lines = [];
        var foldSeq = 0;

        function tok(cls, txt) { return '<span class="kojv__' + cls + '">' + esc(txt) + '</span>'; }

        // tokenize: comments, CDATA, tags, text
        var parts = [];
        var re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g, m;
        while ((m = re.exec(src)) !== null) { if (m[0]) parts.push(m[0]); }

        function renderTag(tag) {
            var mm = tag.match(/^<\/?\s*([A-Za-z_][\w.:-]*)/);
            var name = mm ? mm[1] : '';
            var closing = /^<\//.test(tag);
            var selfClose = /\/>\s*$/.test(tag);
            var html = tok('p', closing ? '</' : '<') + tok('tg', name);
            var attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g, am;
            var rest = tag.replace(/^<\/?\s*[A-Za-z_][\w.:-]*/, '').replace(/\/?>\s*$/, '');
            while ((am = attrRe.exec(rest)) !== null) {
                html += ' ' + tok('k', am[1]) + tok('p', '=') + tok('s', am[2]);
            }
            html += tok('p', selfClose ? '/>' : '>');
            return { html: html, name: name, closing: closing, selfClose: selfClose };
        }

        var depth = 0;
        var foldStack = [];
        function indentStr(d) { var s = ''; for (var i = 0; i < d; i++) s += pad; return s; }
        function isTag(s) { return /^</.test(s) && !/^<!--/.test(s) && !/^<!\[CDATA\[/.test(s) && !/^<[!?]/.test(s); }
        function textOf(s) { return s.replace(/\s+/g, ' ').replace(/^ | $/g, ''); }

        for (var p = 0; p < parts.length; p++) {
            var piece = parts[p];
            if (/^<!--/.test(piece)) {
                lines.push({ indent: depth, html: indentStr(depth) + tok('cm', piece), fold: null });
            } else if (/^<!\[CDATA\[/.test(piece)) {
                var body = piece.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
                lines.push({ indent: depth, html: indentStr(depth) + tok('cd', '<![CDATA[') + esc(body) + tok('cd', ']]>'), fold: null });
            } else if (/^<[!?]/.test(piece)) {
                lines.push({ indent: depth, html: indentStr(depth) + tok('cm', piece), fold: null });
            } else if (isTag(piece)) {
                var t = renderTag(piece);
                if (t.closing) {
                    depth = Math.max(0, depth - 1);
                    if (foldStack.length && foldStack[foldStack.length - 1].name === t.name) {
                        var frame = foldStack.pop();
                        var closeIdx = lines.push({ indent: depth, html: indentStr(depth) + t.html, fold: null }) - 1;
                        if (frame.childElems > 0) {
                            lines[frame.lineIndex].fold = frame.foldId;
                            lines[frame.lineIndex].summary = '<' + t.name + '> … </' + t.name + '> · ' +
                                frame.childElems + ' child' + (frame.childElems === 1 ? '' : 'ren');
                            lines[frame.lineIndex].foldEnd = closeIdx;
                        }
                    } else {
                        lines.push({ indent: depth, html: indentStr(depth) + t.html, fold: null });
                    }
                } else if (t.selfClose) {
                    if (foldStack.length) foldStack[foldStack.length - 1].childElems++;
                    lines.push({ indent: depth, html: indentStr(depth) + t.html, fold: null });
                } else {
                    // Lookahead: <tag>text</tag> or <tag></tag> → ONE inline line (a leaf).
                    var nxt = parts[p + 1], nx2 = parts[p + 2];
                    var nxtClose = nxt && isTag(nxt) && /^<\//.test(nxt);
                    var nxtText = nxt && !/^</.test(nxt);
                    var nx2Close = nx2 && isTag(nx2) && /^<\//.test(nx2);
                    if (nxtClose) {                                   // <tag></tag>
                        if (foldStack.length) foldStack[foldStack.length - 1].childElems++;
                        lines.push({ indent: depth, html: indentStr(depth) + t.html + renderTag(nxt).html, fold: null });
                        p += 1; continue;
                    }
                    if (nxtText && nx2Close) {                        // <tag>text</tag>
                        if (foldStack.length) foldStack[foldStack.length - 1].childElems++;
                        var leafTxt = textOf(nxt);
                        lines.push({ indent: depth, html: indentStr(depth) + t.html + tok('s', leafTxt) + renderTag(nx2).html, fold: null });
                        p += 2; continue;
                    }
                    // container element → open line, recurse via depth + foldStack
                    if (foldStack.length) foldStack[foldStack.length - 1].childElems++;
                    var fid = 'x' + (++foldSeq);
                    var li = lines.push({ indent: depth, html: indentStr(depth) + t.html, fold: null }) - 1;
                    foldStack.push({ foldId: fid, lineIndex: li, name: t.name, childElems: 0 });
                    depth++;
                }
            } else {
                var txt = textOf(piece);
                if (txt) lines.push({ indent: depth, html: indentStr(depth) + tok('s', txt), fold: null });
            }
        }
        return lines;
    }

    return { detect: detect, jsonLines: jsonLines, xmlLines: xmlLines, esc: esc, escHtml: esc };
}));
