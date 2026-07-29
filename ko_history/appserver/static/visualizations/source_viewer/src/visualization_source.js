/*
 * KO History — JSON / XML Source Viewer  (Splunk custom visualization)
 *
 * Renders ONE knowledge-object source string (the value of `dataField` in the
 * first result row) as a syntax-highlighted, line-numbered, foldable listing
 * with a copy-to-clipboard button. Reads like a sealed, numbered, format-
 * stamped record of a KO version — a "chain-of-custody" listing.
 *
 * Handles BOTH:
 *   - Dashboard Studio JSON (raw {...} or wrapped in <dashboard version="2">
 *     <definition><![CDATA[ {...} ]]></definition>)
 *   - Classic Simple XML (<dashboard>/<form>/<view> ...)
 *   - Raw fallback for anything that won't parse.
 *
 * Sandbox-safe: pure client-side string formatting + DOM. No network, no
 * cookies, no iframe — renders identically inside the Dashboard Studio
 * custom-viz sandbox. Copy uses navigator.clipboard with an execCommand
 * fallback (both work in-frame).
 *
 * Expected SPL columns (configurable):
 *   data  - the JSON/XML source (required; field name set by `dataField`)
 *   title - optional, shown in header path (`pathField`)
 *   app   - optional, shown as leading path segment (`appField`)
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function (SplunkVisualizationBase, SplunkVisualizationUtils) {

    // ── render-key hash (djb2 + FNV-1a, ES5) ─────────────────
    function hashString(s) {
        if (!s) return '0_0';
        var h1 = 5381;
        var h2 = 2166136261;
        var FNV_PRIME = 16777619;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            h1 = (((h1 << 5) + h1) + c) | 0;
            h2 = h2 ^ c;
            var lo = (h2 & 0xFFFF) * FNV_PRIME;
            var hi = ((h2 >>> 16) * FNV_PRIME + (lo >>> 16)) & 0xFFFF;
            h2 = ((hi << 16) | (lo & 0xFFFF)) >>> 0;
        }
        return (h1 >>> 0).toString(36) + '_' + h2.toString(36);
    }

    // ── Source tokenizer (shared with src/util/jsonView.js) ──────
    // detect/jsonLines/xmlLines/esc — see ko_history/src/shared/sourceLines.js.
    var _sourceLines = require('../../../../../src/shared/sourceLines.js');
    var detect    = _sourceLines.detect;
    var jsonLines = _sourceLines.jsonLines;
    var xmlLines  = _sourceLines.xmlLines;
    var renderCap = _sourceLines.renderCap;
    var esc       = _sourceLines.esc;

    // ── tiny DOM helpers ──────────────────────────────────────
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    // depth of a value (for footer)
    function jsonDepth(v) {
        if (!v || typeof v !== 'object') return 0;
        var max = 0;
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) {
            var d = jsonDepth(v[k]); if (d > max) max = d;
        }
        return max + 1;
    }

    // Build the full line model for a single source (shared by single + diff views).
    // Returns { det, lines, pretty, footMeta }.
    function buildModel(raw, indent) {
        var det = detect(raw);
        var lines, pretty, footMeta;
        if (det.kind === 'json') {
            try {
                var obj = JSON.parse(det.text);
                lines = jsonLines(obj, indent);
                pretty = JSON.stringify(obj, null, indent);
                footMeta = { ok: 'valid JSON', depth: jsonDepth(obj) };
            } catch (e) {
                det = { kind: 'raw', label: det.label === 'Raw' ? 'Raw' : 'Unparsed' };
            }
        }
        if (det.kind === 'xml') {
            lines = xmlLines(det.text, indent);
            pretty = lines.map(function (l) { return stripTags(l.html); }).join('\n');
            footMeta = { ok: 'well-formed XML', depth: maxIndent(lines) };
        }
        if (det.kind === 'raw') {
            var rawStr = String(raw == null ? '' : raw);
            lines = rawStr.split('\n').map(function (ln) {
                return { indent: 0, html: '<span class="kojv__s">' + esc(ln) + '</span>', fold: null };
            });
            pretty = rawStr;
            footMeta = { ok: det.label === 'Unparsed' ? 'unparsed' : 'raw text', depth: 0 };
        }
        return { det: det, lines: lines, pretty: pretty, footMeta: footMeta };
    }

    // Line diff (baseline a -> target b) keyed on rendered html (identical html ==
    // identical line). Returns ops [{t:'eq'|'del'|'add', line}].
    // Shared engine (prefix/suffix trim, Int32Array, graceful block-replace).
    // See ko_history/src/shared/lineDiff.js for the algorithm.
    var _lineDiffCore = require('../../../../../src/shared/lineDiff.js');

    function diffLines(aLines, bLines) {
        // Key by rendered html so identical visual output = identical "line".
        var ak = new Array(aLines.length), bk = new Array(bLines.length), i;
        for (i = 0; i < aLines.length; i++) ak[i] = aLines[i].html;
        for (i = 0; i < bLines.length; i++) bk[i] = bLines[i].html;

        var result = _lineDiffCore(ak, bk);
        // Map back to the original line objects (result.ops use string keys a/b
        // which equal the html; we need the full line object for rendering).
        var ops = [];
        var ai = 0, bi = 0;
        for (i = 0; i < result.ops.length; i++) {
            var op = result.ops[i];
            if (op.t === 'eq')  { ops.push({ t: 'eq',  line: bLines[bi] }); ai++; bi++; }
            else if (op.t === 'del') { ops.push({ t: 'del', line: aLines[ai] }); ai++; }
            else                { ops.push({ t: 'add', line: bLines[bi] }); bi++; }
        }
        return ops;
    }

    // Pair a del/add run into aligned [left,right] rows for the split diff view.
    function pairDiff(ops) {
        var rows = [], i = 0;
        while (i < ops.length) {
            if (ops[i].t === 'eq') { rows.push({ l: ops[i].line, r: ops[i].line, lt: 'eq', rt: 'eq' }); i++; continue; }
            var dels = [], adds = [];
            while (i < ops.length && ops[i].t === 'del') { dels.push(ops[i].line); i++; }
            while (i < ops.length && ops[i].t === 'add') { adds.push(ops[i].line); i++; }
            var nn = Math.max(dels.length, adds.length);
            for (var k = 0; k < nn; k++) {
                rows.push({
                    l: k < dels.length ? dels[k] : null,
                    r: k < adds.length ? adds[k] : null,
                    lt: k < dels.length ? 'del' : 'none',
                    rt: k < adds.length ? 'add' : 'none'
                });
            }
        }
        return rows;
    }

    return SplunkVisualizationBase.extend({

        initialize: function () {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('ko-json-viewer-viz');
            this.root = el('div', 'kojv');
            this.el.appendChild(this.root);
            this._lastRenderKey = null;
            this._expandAll = false;   // true after user clicks truncation control
        },

        getInitialDataParams: function () {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 10 };
        },

        formatData: function (data) {
            if (!data || !data.rows || data.rows.length === 0) {
                return { empty: true, colIdx: {}, rows: [] };
            }
            var fields = data.fields || [], colIdx = {};
            for (var i = 0; i < fields.length; i++) colIdx[fields[i].name] = i;
            return { empty: false, colIdx: colIdx, rows: data.rows };
        },

        _resolveTheme: function (mode) {
            if (mode === 'dark' || mode === 'light') return mode;
            try {
                var t = SplunkVisualizationUtils && SplunkVisualizationUtils.getCurrentTheme &&
                    SplunkVisualizationUtils.getCurrentTheme();
                if (t === 'dark' || t === 'light') return t;
            } catch (e) {}
            return 'dark';
        },

        updateView: function (data, config) {
            if (!data) { return; }
            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var g = function (k, d) { var v = config[ns + k]; return v === undefined ? d : v; };
            var c = {
                dataField: g('dataField', 'data'),
                pathField: g('pathField', 'title'),
                appField: g('appField', 'app'),
                indent: Math.max(1, Math.min(8, parseInt(g('indent', '2'), 10) || 2)),
                initialDepth: (function () {
                    var v = g('initialDepth', '0');
                    if (v === '' || v === undefined || v === null) return -1; // fully expanded
                    var n = parseInt(v, 10);
                    return isNaN(n) ? 0 : n;
                })(),
                showLineNumbers: g('showLineNumbers', 'true') === 'true',
                showFooter: g('showFooter', 'true') === 'true',
                // Default ON: clipping a long line hides content silently, which
                // is worse than a taller row. Turn it off for a fixed-width view.
                wrap: g('wrap', 'true') === 'true',
                banding: g('banding', 'true') === 'true',
                showCopy: g('showCopy', 'true') === 'true',
                theme: this._resolveTheme(g('themeMode', 'auto')),
                // diff mode: auto = diff when two versions are present, else single.
                mode: g('mode', 'auto'),
                diffView: g('diffView', 'split') === 'unified' ? 'unified' : 'split',
                roleField: g('roleField', 'role'),
                baselineValue: g('baselineValue', 'baseline'),
                targetValue: g('targetValue', 'target')
            };

            if (data.empty || !data.rows.length) {
                this._resetModelFields();
                this._lastRenderKey = null;
                this.root.className = 'kojv kojv--' + c.theme +
                    (c.wrap ? ' kojv--wrap' : '') + (c.banding ? ' kojv--banded' : '');
                this.root.innerHTML = '';
                this.root.appendChild(el('div', 'kojv__empty', 'Awaiting data. Provide a result row with a source column.'));
                return;
            }
            if (data.colIdx[c.dataField] === undefined) {
                this._resetModelFields();
                this._lastRenderKey = null;
                this.root.className = 'kojv kojv--' + c.theme +
                    (c.wrap ? ' kojv--wrap' : '') + (c.banding ? ' kojv--banded' : '');
                this.root.innerHTML = '';
                this.root.appendChild(el('div', 'kojv__empty',
                    'Source field "' + c.dataField + '" not found. Columns: ' + Object.keys(data.colIdx).join(', ')));
                return;
            }

            var di = data.colIdx[c.dataField];
            var rows = data.rows;
            function cell(r, f) {
                var idx = (f && data.colIdx[f] !== undefined) ? data.colIdx[f] : -1;
                return idx >= 0 ? r[idx] : '';
            }

            // Resolve baseline/target rows. Prefer an explicit role column (case-insensitive);
            // fallback: row 0 = target (newest), row 1 = baseline (previous).
            var targetRow = null, baseRow = null;
            var ri = (c.roleField && data.colIdx[c.roleField] !== undefined) ? data.colIdx[c.roleField] : -1;
            if (ri >= 0) {
                for (var k = 0; k < rows.length; k++) {
                    var rv = String(rows[k][ri] == null ? '' : rows[k][ri]).trim().toLowerCase();
                    if (rv === String(c.targetValue).trim().toLowerCase() && !targetRow) targetRow = rows[k];
                    else if (rv === String(c.baselineValue).trim().toLowerCase() && !baseRow) baseRow = rows[k];
                }
                if (!targetRow && rows.length) targetRow = rows[0];
                if (!baseRow && rows.length > 1) baseRow = rows[1];
            } else {
                targetRow = rows[0];
                if (rows.length > 1) baseRow = rows[1];
            }

            var tRaw = targetRow ? targetRow[di] : '';
            var title = targetRow ? cell(targetRow, c.pathField) : '';
            var app = targetRow ? cell(targetRow, c.appField) : '';

            var wantDiff = (c.mode === 'diff') || (c.mode !== 'single' && !!baseRow);

            // ── render-key cache: skip full rebuild when data + config are identical ──
            // Full-content hashes (not edge samples) so same-length mid-content edits
            // produce a different key and trigger a re-render (D2 fix).
            var bRaw = (wantDiff && baseRow) ? baseRow[di] : '';
            var renderKey = hashString(tRaw) + ':' + hashString(bRaw) + ':' +
                c.indent + c.initialDepth + (c.showLineNumbers ? 1 : 0) +
                (c.showFooter ? 1 : 0) + (c.wrap ? 1 : 0) + (c.banding ? 1 : 0) +
                (c.showCopy ? 1 : 0) + c.theme + c.diffView + (wantDiff ? 1 : 0);
            if (renderKey === this._lastRenderKey && this.root.firstChild) {
                return;
            }
            this._lastRenderKey = renderKey;
            this._expandAll = false;   // new data always resets per-render expansion

            // ── reset ALL mode fields before rebuild to release detached DOM ──
            this._resetModelFields();

            if (wantDiff && baseRow) {
                this._renderDiff(bRaw, tRaw, title, app, c);
            } else {
                this._render(tRaw, title, app, c);
            }
        },

        // Release all mode-specific fields so detached DOM generations are unpinned.
        // Called before every full rebuild AND in every placeholder branch (V2 fix).
        _resetModelFields: function () {
            this._allLines = null;
            this._foldGroups = null;
            this._diffOps = null;
            this._diffBody = null;
        },

        _render: function (raw, title, app, c) {
            // cache for click-to-expand re-render (direct call bypasses updateView)
            this._listingRaw   = raw;
            this._listingTitle = title;
            this._listingApp   = app;
            this._listingC     = c;

            this.root.className = 'kojv kojv--' + c.theme +
                (c.wrap ? ' kojv--wrap' : '') + (c.banding ? ' kojv--banded' : '');
            this.root.innerHTML = '';

            var mdl = buildModel(raw, c.indent);
            var det = mdl.det, lines = mdl.lines, pretty = mdl.pretty, footMeta = mdl.footMeta;

            // ── header ──
            var head = el('div', 'kojv__head');
            var tag = el('div', 'kojv__tag' + (det.label === 'Raw' || det.label === 'Unparsed' ? ' kojv__tag--muted' : ''), det.label);
            head.appendChild(tag);

            var path = el('div', 'kojv__path');
            var segs = [];
            if (app) segs.push(esc(String(app)));
            segs.push('views');
            if (title) segs.push('<b style="font-weight:600">' + esc(String(title)) + '</b>');
            path.innerHTML = segs.join('<span class="sep">/</span>');
            if (!app && !title) path.textContent = '';
            head.appendChild(path);

            var bytes = (pretty || '').length;
            var meta = el('div', 'kojv__meta');
            meta.innerHTML = '<b>' + bytes.toLocaleString() + '</b> bytes · <b>' + lines.length + '</b> lines';
            head.appendChild(meta);

            var hasFolds = false;
            for (var fi = 0; fi < lines.length; fi++) { if (lines[fi].fold) { hasFolds = true; break; } }
            // fold controls are built AFTER the body loop (needs _maxDepth); a
            // placeholder slot keeps them in the right header position.
            var foldSlot = null;
            if (hasFolds) { foldSlot = el('div', 'kojv__foldall'); head.appendChild(foldSlot); }

            if (c.showCopy) {
                var copy = el('button', 'kojv__copy');
                copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<rect x="9" y="9" width="11" height="11" rx="1.5"/>' +
                    '<path d="M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15"/></svg><span>Copy</span>';
                var srcText = pretty;
                copy.addEventListener('click', function () { copyToClipboard(srcText, copy); });
                head.appendChild(copy);
            }
            this.root.appendChild(head);

            // ── body ──
            var body = el('div', 'kojv__body');
            this._foldGroups = {};   // foldId -> { parentLine, childLines:[], depth }
            this._allLines = [];     // every line el, in document order (for zebra restripe)
            this._maxDepth = 0;      // deepest foldable nesting level
            this._shownDepth = -1;   // current "collapse to level" state; -1 = fully expanded

            var cap = renderCap(lines.length, this._expandAll).limit;
            var self = this;
            for (var i = 0; i < lines.length && i < cap; i++) {
                var L = lines[i];
                var lineEl = el('div', 'kojv__line');
                if (c.showLineNumbers) lineEl.appendChild(el('span', 'kojv__ln', String(i + 1)));

                var code = el('span', 'kojv__code');
                if (L.fold && L.foldEnd > i) {
                    code.className = 'kojv__code kojv__code--foldable';
                    var caret = el('span', 'kojv__fold');
                    code.appendChild(caret);
                    var inner = document.createElement('span');
                    inner.innerHTML = L.html;
                    code.appendChild(inner);
                    var summary = el('span', 'kojv__summary', L.summary || '…');
                    code.appendChild(summary);
                    lineEl.setAttribute('data-fold', L.fold);
                    // range model: this fold owns lines (i, foldEnd]
                    this._foldGroups[L.fold] = { parentLine: lineEl, depth: L.indent, start: i, end: L.foldEnd };
                    if (L.indent > this._maxDepth) this._maxDepth = L.indent;
                    var fself = this, fid2 = L.fold;
                    code.addEventListener('click', function (fidCapture) {
                        return function (ev) { ev.stopPropagation(); fself._toggleFold(fidCapture); };
                    }(fid2));
                } else {
                    code.innerHTML = L.html;
                }
                lineEl.appendChild(code);
                body.appendChild(lineEl);
                this._allLines.push(lineEl);
            }
            if (lines.length > cap) {
                var capNotice = el('div', 'kojv__truncrow kojv__line');
                capNotice.setAttribute('role', 'button');
                capNotice.setAttribute('tabindex', '0');
                capNotice.appendChild(el('span', 'kojv__code',
                    'truncated: showing first 4,000 of ' + lines.length.toLocaleString() + ' lines · click to show all'));
                capNotice.addEventListener('click', function () {
                    self._expandAll = true;
                    self._render(self._listingRaw, self._listingTitle, self._listingApp, self._listingC);
                });
                capNotice.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.keyCode === 13) {
                        self._expandAll = true;
                        self._render(self._listingRaw, self._listingTitle, self._listingApp, self._listingC);
                    }
                });
                body.appendChild(capNotice);
            }
            this.root.appendChild(body);

            // ── fold controls (built now that _maxDepth is known) ──
            // Per-level collapsing: −/+ change how many nesting levels are shown,
            // one layer at a time; All/None are the extremes.
            if (foldSlot) {
                // `self` is already bound above, at the top of this same function.
                var levelLbl = el('span', 'kojv__foldlevel', '');
                this._levelLbl = levelLbl;
                var bMinus = el('button', null, '−');   // − collapse one more (deepest) level
                var bPlus  = el('button', null, '+');         // + expand one more level
                var bAll   = el('button', null, 'All');       // expand everything
                var bNone  = el('button', null, 'None');      // collapse everything
                bMinus.title = 'Collapse one more level';
                bPlus.title  = 'Expand one more level';
                bAll.title   = 'Expand all'; bNone.title = 'Collapse all';
                bMinus.addEventListener('click', function () { self._stepLevel(-1, levelLbl); });
                bPlus.addEventListener('click',  function () { self._stepLevel(1, levelLbl); });
                bAll.addEventListener('click',   function () { self._foldAll(false); self._shownDepth = -1; self._levelText(levelLbl); });
                bNone.addEventListener('click',  function () { self._foldAll(true);  self._shownDepth = 0;  self._levelText(levelLbl); });
                foldSlot.appendChild(bNone);
                foldSlot.appendChild(bMinus);
                foldSlot.appendChild(levelLbl);
                foldSlot.appendChild(bPlus);
                foldSlot.appendChild(bAll);
                this._levelText(levelLbl);
            }

            if (hasFolds && c.initialDepth >= 0 && c.initialDepth <= this._maxDepth) {
                this._shownDepth = c.initialDepth;
                this._foldToDepth(c.initialDepth);
                this._levelText(this._levelLbl);
            } else {
                this._restripe();
            }

            // ── footer ──
            if (c.showFooter) {
                var foot = el('div', 'kojv__foot');
                var pieces = [
                    footMeta.ok,
                    'depth ' + footMeta.depth,
                    'indent ' + c.indent + 'sp',
                    bytes.toLocaleString() + ' chars'
                ];
                for (var fp = 0; fp < pieces.length; fp++) {
                    if (fp > 0) foot.appendChild(el('span', 'dot'));
                    foot.appendChild(el('span', null, pieces[fp]));
                }
                this.root.appendChild(foot);
            }
        },

        // re-apply the 2-row zebra band to VISIBLE lines only, so the banding
        // tracks the actual listing and re-stripes cleanly after a fold.
        _restripe: function () {
            if (!this._allLines) return;
            var visIdx = 0;
            for (var i = 0; i < this._allLines.length; i++) {
                var ln = this._allLines[i];
                if (ln.style.display === 'none') { ln.classList.remove('kojv__line--band'); continue; }
                // 2-row cadence: rows 2,3 banded, 4,5 plain, ...  (floor(n/2) % 2)
                var banded = (Math.floor(visIdx / 2) % 2) === 1;
                ln.classList.toggle('kojv__line--band', banded);
                visIdx++;
            }
        },

        // Recompute every line's visibility from the set of FOLDED groups.
        // Range model: a folded group g hides lines (g.start, g.end]. A line is
        // hidden if it falls inside ANY folded group's range — this correctly
        // hides whole subtrees (grandchildren included), unlike direct-children.
        _applyVisibility: function () {
            var folded = [];
            for (var fid in this._foldGroups) {
                if (!Object.prototype.hasOwnProperty.call(this._foldGroups, fid)) continue;
                var g = this._foldGroups[fid];
                if (g.parentLine.classList.contains('is-folded')) folded.push(g);
            }
            for (var i = 0; i < this._allLines.length; i++) {
                var hide = false;
                for (var k = 0; k < folded.length; k++) {
                    if (i > folded[k].start && i <= folded[k].end) { hide = true; break; }
                }
                this._allLines[i].style.display = hide ? 'none' : '';
            }
            this._restripe();
        },

        // collapse/expand a single fold group
        _toggleFold: function (fid) {
            var grp = this._foldGroups[fid];
            if (!grp || !grp.parentLine) return;
            grp.parentLine.classList.toggle('is-folded');
            // a manual single-node toggle no longer matches a clean depth level
            this._shownDepth = -2;
            if (this._levelLbl) this._levelLbl.textContent = 'custom';
            this._applyVisibility();
        },

        _foldAll: function (folded) {
            for (var fid in this._foldGroups) {
                if (!Object.prototype.hasOwnProperty.call(this._foldGroups, fid)) continue;
                this._foldGroups[fid].parentLine.classList.toggle('is-folded', folded);
            }
            this._applyVisibility();
        },

        // Collapse every fold node whose depth >= `level`; expand the rest.
        // level = -1 → everything expanded; level = 0 → only the root open; etc.
        _foldToDepth: function (level) {
            for (var fid in this._foldGroups) {
                if (!Object.prototype.hasOwnProperty.call(this._foldGroups, fid)) continue;
                var grp = this._foldGroups[fid];
                grp.parentLine.classList.toggle('is-folded', level >= 0 && grp.depth >= level);
            }
            this._applyVisibility();
        },

        _stepLevel: function (dir, lbl) {
            // current shown depth: -1 == all expanded, else "collapse to N"
            var cur = this._shownDepth;
            if (cur < 0) cur = this._maxDepth + 1;   // treat "all" as one past deepest
            var next = cur + dir;                    // − collapses (lower N), + expands (higher N)
            if (next < 0) next = 0;
            if (next > this._maxDepth + 1) next = this._maxDepth + 1;
            this._shownDepth = (next > this._maxDepth) ? -1 : next;
            this._foldToDepth(this._shownDepth);
            this._levelText(lbl);
        },

        _levelText: function (lbl) {
            if (!lbl) return;
            if (this._shownDepth < 0) lbl.textContent = 'all levels';
            else lbl.textContent = 'level ' + this._shownDepth + '/' + this._maxDepth;
        },

        // ── diff view: baseline -> target, syntax-highlighted, split or unified ──
        _renderDiff: function (baseRaw, targetRaw, title, app, c) {
            var self = this;
            var mBase = buildModel(baseRaw, c.indent);
            var mTarg = buildModel(targetRaw, c.indent);
            var ops = diffLines(mBase.lines, mTarg.lines);
            this._diffOps = ops;
            this._diffView = c.diffView;

            var adds = 0, dels = 0;
            for (var i = 0; i < ops.length; i++) { if (ops[i].t === 'add') adds++; else if (ops[i].t === 'del') dels++; }

            this.root.className = 'kojv kojv--' + c.theme + ' kojv--diff' + (c.wrap ? ' kojv--wrap' : '');
            this.root.innerHTML = '';

            var head = el('div', 'kojv__head');
            head.appendChild(el('div', 'kojv__tag', mTarg.det.label));
            var path = el('div', 'kojv__path');
            var segs = [];
            if (app) segs.push(esc(String(app)));
            segs.push('views');
            if (title) segs.push('<b style="font-weight:600">' + esc(String(title)) + '</b>');
            path.innerHTML = segs.join('<span class="sep">/</span>');
            if (!app && !title) path.textContent = '';
            head.appendChild(path);

            var meta = el('div', 'kojv__meta');
            meta.innerHTML = '<span class="kojv__dstat kojv__dstat--del">−' + dels + '</span> ' +
                '<span class="kojv__dstat kojv__dstat--add">+' + adds + '</span> older → newer';
            head.appendChild(meta);

            var slot = el('div', 'kojv__foldall');
            var bSplit = el('button', null, 'Split');
            var bUnified = el('button', null, 'Unified');
            function syncToggle() {
                bSplit.className = self._diffView === 'split' ? 'is-on' : '';
                bUnified.className = self._diffView === 'unified' ? 'is-on' : '';
            }
            bSplit.addEventListener('click', function () { self._diffView = 'split'; syncToggle(); self._drawDiffBody(); });
            bUnified.addEventListener('click', function () { self._diffView = 'unified'; syncToggle(); self._drawDiffBody(); });
            slot.appendChild(bSplit);
            slot.appendChild(bUnified);
            head.appendChild(slot);

            if (c.showCopy) {
                // Both sides are copyable. Recovering an old version by hand is a
                // real workflow, and until now only the newer side could be lifted
                // out. Order matches the "older -> newer" direction stated to the
                // left, so the toolbar reads consistently.
                var copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<rect x="9" y="9" width="11" height="11" rx="1.5"/>' +
                    '<path d="M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15"/></svg>';
                var mkCopy = function (label, text) {
                    var b = el('button', 'kojv__copy');
                    b.innerHTML = copyIcon + '<span>' + label + '</span>';
                    b.setAttribute('title', 'Copy the ' + label.replace('Copy ', '') + ' version to the clipboard');
                    // `text` is captured per button, so the two never share a source.
                    b.addEventListener('click', function () { copyToClipboard(text, b); });
                    return b;
                };
                head.appendChild(mkCopy('Copy older', mBase.pretty));
                head.appendChild(mkCopy('Copy newer', mTarg.pretty));
            }
            this.root.appendChild(head);

            var body = el('div', 'kojv__body');
            this._diffBody = body;
            this.root.appendChild(body);
            syncToggle();
            this._drawDiffBody();

            if (c.showFooter) {
                var foot = el('div', 'kojv__foot');
                var pieces = ['version diff', dels + ' removed', adds + ' added', ops.length + ' rows'];
                for (var fp = 0; fp < pieces.length; fp++) {
                    if (fp > 0) foot.appendChild(el('span', 'dot'));
                    foot.appendChild(el('span', null, pieces[fp]));
                }
                this.root.appendChild(foot);
            }
        },

        _drawDiffBody: function () {
            var body = this._diffBody;
            if (!body) return;
            body.innerHTML = '';
            var ops = this._diffOps, i;
            var cap = renderCap(this._diffOps.length, this._expandAll).limit;
            var self = this;

            // shared factory for the click-to-expand truncation control
            function makeTruncRow(total) {
                var r = el('div', 'kojv__truncrow kojv__line');
                r.setAttribute('role', 'button');
                r.setAttribute('tabindex', '0');
                r.appendChild(el('span', 'kojv__code',
                    'truncated: showing first 4,000 of ' + total.toLocaleString() + ' lines · click to show all'));
                r.addEventListener('click', function () { self._expandAll = true; self._drawDiffBody(); });
                r.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.keyCode === 13) { self._expandAll = true; self._drawDiffBody(); }
                });
                return r;
            }

            if (this._diffView === 'unified') {
                for (i = 0; i < ops.length && i < cap; i++) {
                    var op = ops[i];
                    var ln = el('div', 'kojv__line' + (op.t === 'add' ? ' kojv__line--add' : op.t === 'del' ? ' kojv__line--del' : ''));
                    ln.appendChild(el('span', 'kojv__dsign', op.t === 'add' ? '+' : op.t === 'del' ? '−' : ''));
                    var code = el('span', 'kojv__code');
                    code.innerHTML = op.line.html;
                    ln.appendChild(code);
                    body.appendChild(ln);
                }
                if (ops.length > cap) {
                    body.appendChild(makeTruncRow(ops.length));
                }
            } else {
                var hdr = el('div', 'kojv__diffhdr');
                hdr.appendChild(el('div', 'kojv__diffhdr-l', 'OLDER'));
                hdr.appendChild(el('div', 'kojv__diffhdr-r', 'NEWER'));
                body.appendChild(hdr);
                var rows = pairDiff(ops);
                for (i = 0; i < rows.length && i < cap; i++) {
                    var r = rows[i];
                    var row = el('div', 'kojv__line');
                    var left = el('span', 'kojv__half kojv__half--l kojv__half--' + r.lt);
                    left.innerHTML = r.l ? r.l.html : '';
                    var right = el('span', 'kojv__half kojv__half--' + r.rt);
                    right.innerHTML = r.r ? r.r.html : '';
                    row.appendChild(left);
                    row.appendChild(right);
                    body.appendChild(row);
                }
                if (rows.length > cap) {
                    body.appendChild(makeTruncRow(rows.length));
                }
            }
        },

        reflow: function () {},

        remove: function() {
            this._resetModelFields();
            this._lastRenderKey = null;
            if (SplunkVisualizationBase.prototype.remove) {
                SplunkVisualizationBase.prototype.remove.apply(this, arguments);
            }
        }
    });

    // ── shared utilities (module scope) ───────────────────────
    function stripTags(html) {
        return String(html).replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    function maxIndent(lines) {
        var m = 0; for (var i = 0; i < lines.length; i++) if (lines[i].indent > m) m = lines[i].indent;
        return m;
    }
    function copyToClipboard(text, btn) {
        function flash() {
            // Restore this button's OWN label. Resetting to a hardcoded "Copy"
            // renamed "Copy newer" to "Copy" after a single use, and with both a
            // newer and an older button that made them indistinguishable.
            var span = btn.querySelector('span');
            var original = span ? span.textContent : '';
            btn.classList.add('is-copied');
            if (span) span.textContent = 'Copied ✓';
            setTimeout(function () {
                btn.classList.remove('is-copied');
                var s2 = btn.querySelector('span');
                if (s2) s2.textContent = original;
            }, 1400);
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(flash, function () { legacy(); });
                return;
            }
        } catch (e) {}
        legacy();
        function legacy() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.focus(); ta.select();
                document.execCommand('copy'); document.body.removeChild(ta);
                flash();
            } catch (e2) {}
        }
    }
});
