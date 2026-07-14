/*
 * Dashboard Diff (Schematic) - Splunk Custom Visualization
 *
 * Sandbox-proof preview + diff that works INSIDE Dashboard Studio (and Simple
 * XML). Dashboard Studio runs custom visualizations in a sandboxed iframe
 * (no allow-same-origin), which blocks cookies, authenticated writes, and
 * cross-frame reads — so the write-then-iframe live preview cannot run there.
 *
 * This viz needs NONE of that: it receives two dashboard sources (baseline +
 * target) as search data, parses them entirely client-side, and DRAWS a
 * faithful schematic of the target dashboard's layout — every panel as a
 * positioned box with its title and visualization type — coloured by the diff
 * against the baseline (added / changed / moved / removed). No network, no
 * cookies, no iframe: it renders the same in a sandbox as anywhere else.
 *
 * Works for both Dashboard Studio (exact x/y/w/h from layout.structure) and
 * Classic Simple XML (panels flowed into their rows).
 *
 * Expected SPL columns (configurable):
 *   data  - dashboard source (eai:data envelope), required
 *   role  - "baseline" | "target" (else first row = baseline, last = target)
 */
// ── Runtime publicPath ──────────────────────────────────────────────────────
// Webpack needs to know where to fetch async chunks (live_render.chunk.js).
// We cannot hard-code the locale (/en-US/) or proxy prefix in the config, so
// we derive the path from the URL of THIS script file at eval time.
// document.currentScript is set while a <script> tag is being evaluated;
// AMD loaders typically inject a new <script> tag per module, so it is
// available here. We fall back to a locale-prefix derivation when it is null
// (some AMD environments reuse one script element).
(function () {
    var src = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
    if (src) {
        // Strip "visualization.js" (and any query/hash) → keep the directory.
        __webpack_public_path__ = src.replace(/[^/]*$/, ''); // eslint-disable-line no-undef
    } else if (typeof window !== 'undefined') {
        // Fallback: reconstruct from window.location.
        // Splunk static paths:  /<locale>/static/app/<app>/visualizations/<viz>/
        var parts = window.location.pathname.split('/').filter(Boolean);
        var locale = parts[0] || 'en-US';
        __webpack_public_path__ = window.location.origin + '/' + locale + // eslint-disable-line no-undef
            '/static/app/ko_history/visualizations/dashboard_preview_ds/';
    }
}());

define([
    'api/SplunkVisualizationBase'
], function(SplunkVisualizationBase) {

    // ── Pure helpers: parsing + diff (shared with the SXML-host viz) ──

    function detectKind(xml) {
        if (!xml || typeof xml !== 'string') return 'unknown';
        var vMatch = xml.match(/<dashboard[^>]*\bversion\s*=\s*["']([^"']+)["']/i);
        if (vMatch && vMatch[1] === '2') return 'studio';
        if (/<form[^>]*\bversion\s*=\s*["']2["']/i.test(xml)) return 'studio';
        if (/<dashboard\b/i.test(xml) || /<form\b/i.test(xml)) return 'sxml';
        var t = xml.replace(/^\s+/, '');
        if (t.charAt(0) === '{') return 'studio';
        return 'unknown';
    }

    function extractStudioDefinition(xml) {
        if (!xml) return null;
        var m = xml.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
        var jsonText = null;
        if (m) {
            jsonText = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
        } else {
            var t = xml.replace(/^\s+/, '');
            if (t.charAt(0) === '{') jsonText = t;
        }
        if (!jsonText) return null;
        try { return JSON.parse(jsonText); } catch (e) { return null; }
    }

    // ── render-key hash (djb2 + FNV-1a, ES5) ─────────────────────────────────
    // Duplicated from json_viewer/visualization_source.js — shared-module
    // extraction is deferred to the roadmap consolidation pass.
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

    function stableStringify(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Object.prototype.toString.call(v) === '[object Array]') {
            var arr = [];
            for (var i = 0; i < v.length; i++) arr.push(stableStringify(v[i]));
            return '[' + arr.join(',') + ']';
        }
        var keys = [];
        for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k); }
        keys.sort();
        var parts = [];
        for (var j = 0; j < keys.length; j++) parts.push(JSON.stringify(keys[j]) + ':' + stableStringify(v[keys[j]]));
        return '{' + parts.join(',') + '}';
    }

    function get(obj, path) {
        var cur = obj;
        for (var i = 0; i < path.length; i++) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[path[i]];
        }
        return cur;
    }

    function vizQuery(def, viz) {
        if (!viz || !viz.dataSources) return '';
        var dsId = viz.dataSources.primary;
        if (!dsId || !def.dataSources || !def.dataSources[dsId]) return '';
        return get(def.dataSources[dsId], ['options', 'query']) || '';
    }

    function shortType(t) {
        if (!t) return '';
        return String(t).replace(/^splunk\./, '');
    }

    // Studio diff (match by viz id) → unified change list.
    function diffStudio(baseDef, targDef) {
        var changes = [];
        baseDef = baseDef || {}; targDef = targDef || {};
        var bViz = baseDef.visualizations || {}, tViz = targDef.visualizations || {};
        function posMap(def) {
            var map = {}, struct = get(def, ['layout', 'structure']) || [];
            for (var i = 0; i < struct.length; i++) { var it = struct[i]; if (it && it.item) map[it.item] = it.position || {}; }
            return map;
        }
        var bPos = posMap(baseDef), tPos = posMap(targDef), seen = {}, id;
        for (id in tViz) {
            if (!Object.prototype.hasOwnProperty.call(tViz, id)) continue;
            seen[id] = true;
            var tv = tViz[id], label = (tv && tv.title) || shortType(tv && tv.type) || id;
            if (!Object.prototype.hasOwnProperty.call(bViz, id)) {
                changes.push({ id: id, label: label, kind: 'added', details: ['new panel (' + shortType(tv && tv.type) + ')'] });
                continue;
            }
            var bv = bViz[id], details = [];
            if ((bv && bv.type) !== (tv && tv.type)) details.push('type: ' + shortType(bv && bv.type) + ' → ' + shortType(tv && tv.type));
            if ((bv && bv.title) !== (tv && tv.title) && ((bv && bv.title) || (tv && tv.title)))
                details.push('title: "' + ((bv && bv.title) || '') + '" → "' + ((tv && tv.title) || '') + '"');
            if (stableStringify(bv && bv.options) !== stableStringify(tv && tv.options)) details.push('options changed');
            if (vizQuery(baseDef, bv) !== vizQuery(targDef, tv)) details.push('search changed');
            var bp = bPos[id] || {}, tp = tPos[id] || {};
            var moved = (bp.x !== tp.x) || (bp.y !== tp.y) || (bp.w !== tp.w) || (bp.h !== tp.h);
            if (details.length > 0) changes.push({ id: id, label: label, kind: 'changed', details: details });
            else if (moved) changes.push({ id: id, label: label, kind: 'moved',
                details: ['moved/resized (' + bp.x + ',' + bp.y + ' ' + bp.w + 'x' + bp.h + ' → ' + tp.x + ',' + tp.y + ' ' + tp.w + 'x' + tp.h + ')'] });
        }
        for (id in bViz) {
            if (!Object.prototype.hasOwnProperty.call(bViz, id)) continue;
            if (!seen[id]) { var rv = bViz[id]; changes.push({ id: id, label: (rv && rv.title) || id, kind: 'removed', details: ['panel removed'] }); }
        }
        return changes;
    }

    // SXML parse: rows of panels (preserves row grouping for the schematic).
    function parseSxmlRows(xml) {
        var rows = [];
        try {
            var doc = new DOMParser().parseFromString(xml, 'text/xml');
            if (doc.getElementsByTagName('parsererror').length) return rows;
            var rowNodes = doc.getElementsByTagName('row');
            for (var r = 0; r < rowNodes.length; r++) {
                var panelNodes = rowNodes[r].getElementsByTagName('panel');
                var rowPanels = [];
                for (var i = 0; i < panelNodes.length; i++) rowPanels.push(parseSxmlPanel(panelNodes[i]));
                if (rowPanels.length) rows.push(rowPanels);
            }
            // Some dashboards put panels outside <row>; capture any stragglers.
            if (!rows.length) {
                var all = doc.getElementsByTagName('panel'), loose = [];
                for (var p = 0; p < all.length; p++) loose.push(parseSxmlPanel(all[p]));
                if (loose.length) rows.push(loose);
            }
        } catch (e) { /* tolerate */ }
        return rows;
    }

    function parseSxmlPanel(p) {
        var titleNodes = p.getElementsByTagName('title');
        var title = titleNodes.length ? (titleNodes[0].textContent || '').trim() : '';
        var queries = p.getElementsByTagName('query'), qtext = [];
        for (var q = 0; q < queries.length; q++) qtext.push((queries[q].textContent || '').trim());
        var types = [], kids = p.childNodes;
        for (var c = 0; c < kids.length; c++) {
            if (kids[c].nodeType === 1) {
                var nm = kids[c].nodeName.toLowerCase();
                if (nm !== 'title' && nm !== 'search') types.push(nm);
            }
        }
        return { title: title, query: qtext.join(' || '), types: types.join(',') };
    }

    function flattenSxml(rows) {
        var flat = [];
        for (var r = 0; r < rows.length; r++) for (var i = 0; i < rows[r].length; i++) flat.push(rows[r][i]);
        return flat;
    }

    // SXML diff by panel index (matches schematic index ids).
    function diffSxml(baseXml, targXml) {
        var changes = [];
        var b = flattenSxml(parseSxmlRows(baseXml)), t = flattenSxml(parseSxmlRows(targXml));
        var n = Math.max(b.length, t.length);
        for (var i = 0; i < n; i++) {
            var bp = b[i], tp = t[i], label = (tp && tp.title) || (bp && bp.title) || ('panel ' + (i + 1));
            if (bp && !tp) { changes.push({ id: i, label: (bp.title || 'panel ' + (i + 1)), kind: 'removed', details: ['panel removed'] }); continue; }
            if (!bp && tp) { changes.push({ id: i, label: label, kind: 'added', details: ['new panel'] }); continue; }
            var details = [];
            if (bp.title !== tp.title && (bp.title || tp.title)) details.push('title: "' + bp.title + '" → "' + tp.title + '"');
            if (bp.types !== tp.types) details.push('viz type: ' + (bp.types || '?') + ' → ' + (tp.types || '?'));
            if (bp.query !== tp.query) details.push('search changed');
            if (details.length) changes.push({ id: i, label: label, kind: 'changed', details: details });
        }
        return changes;
    }

    // ── Schematic model: unified {canvasW, canvasH, panels[]} ────

    // Walk the whole layout (absolute / grid / tabs / nested) and collect any
    // {item, position:{x,y,w,h}} mapping we can find, keyed by viz id.
    function collectPositions(node, map) {
        if (!node || typeof node !== 'object') return;
        if (Object.prototype.toString.call(node) === '[object Array]') {
            for (var i = 0; i < node.length; i++) collectPositions(node[i], map);
            return;
        }
        if (node.item && node.position && typeof node.position.x === 'number') {
            map[node.item] = node.position;
        }
        for (var k in node) {
            if (Object.prototype.hasOwnProperty.call(node, k)) {
                var v = node[k];
                if (v && typeof v === 'object') collectPositions(v, map);
            }
        }
    }

    // Build the schematic from the SAME visualizations map the diff uses, so
    // the board can never disagree with the change counts. Positions come from
    // the layout when present; anything without one flows into a grid.
    function buildStudioSchematic(def) {
        var viz = (def && def.visualizations) || {};
        var layout = (def && def.layout) || {};
        var opt = layout.options || {};
        var canvasW = opt.width || 1440;
        var posMap = {};
        collectPositions(layout, posMap);

        var ids = [];
        for (var id in viz) if (Object.prototype.hasOwnProperty.call(viz, id)) ids.push(id);

        var cols = ids.length > 9 ? 4 : (ids.length > 4 ? 3 : 2);
        var cellW = (canvasW - 20) / cols, cellH = 170, gap = 10, gi = 0;
        var panels = [], maxY = 0;
        for (var i = 0; i < ids.length; i++) {
            var v = viz[ids[i]] || {};
            var pos = posMap[ids[i]], x, y, w, h;
            if (pos) {
                x = pos.x; y = pos.y; w = pos.w; h = pos.h;
            } else {
                var col = gi % cols, rowi = Math.floor(gi / cols);
                x = 10 + col * cellW; y = 10 + rowi * (cellH + gap);
                w = cellW - gap; h = cellH; gi++;
            }
            if (y + h > maxY) maxY = y + h;
            panels.push({ id: ids[i], x: x, y: y, w: w, h: h,
                title: v.title || '', vizType: shortType(v.type) });
        }
        return { canvasW: canvasW, canvasH: Math.max(opt.height || 0, maxY + 20, 200), panels: panels };
    }

    function buildSxmlSchematic(rows) {
        var canvasW = 1200, rowH = 200, gap = 12, pad = 10;
        var panels = [], y = pad, idx = 0;
        for (var r = 0; r < rows.length; r++) {
            var k = rows[r].length, w = (canvasW - pad * 2 - gap * (k - 1)) / k;
            for (var i = 0; i < k; i++) {
                var p = rows[r][i];
                panels.push({ id: idx, x: pad + i * (w + gap), y: y, w: w, h: rowH,
                    title: p.title || '', vizType: p.types || '' });
                idx++;
            }
            y += rowH + gap;
        }
        return { canvasW: canvasW, canvasH: y + pad, panels: panels };
    }

    // ── Source line diff (LCS) ──────────────────────────────────
    // Shared engine (prefix/suffix trim, Int32Array, graceful block-replace).
    // See ko_history/src/shared/lineDiff.js for the algorithm.
    var _lineDiffCore = require('../../../../../src/shared/lineDiff.js');

    function prettyForDiff(xml, kind) {
        if (kind === 'studio') {
            var def = extractStudioDefinition(xml);
            if (def) { try { return JSON.stringify(def, null, 2); } catch (e) {} }
        }
        return xml || '';
    }

    // Adapter: shared ops ({t,a,b}) → dashboard_preview_ds format [{type,text}].
    function lineDiff(aText, bText) {
        var a = (aText || '').split('\n');
        var b = (bText || '').split('\n');
        var result = _lineDiffCore(a, b);
        if (result.degraded) {
            return [{ type: 'info', text: 'Source too large for line diff (' + a.length + ' vs ' + b.length + ' lines).' }];
        }
        var out = [];
        for (var i = 0; i < result.ops.length; i++) {
            var op = result.ops[i];
            if (op.t === 'eq')  out.push({ type: 'ctx', text: op.a });
            else if (op.t === 'del') out.push({ type: 'del', text: op.a });
            else                out.push({ type: 'add', text: op.b });
        }
        return out;
    }

    // ── DOM helpers ─────────────────────────────────────────────

    function el(tag, className, text) {
        var n = document.createElement(tag);
        if (className) n.className = className;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    var KIND_COLORS = {
        added:   { border: '#3fb950', label: 'ADDED',   chip: 'dpd-chip--added' },
        changed: { border: '#d29922', label: 'CHANGED', chip: 'dpd-chip--changed' },
        moved:   { border: '#58a6ff', label: 'MOVED',   chip: 'dpd-chip--moved' },
        removed: { border: '#f85149', label: 'REMOVED', chip: 'dpd-chip--removed' },
        same:    { border: 'rgba(255,255,255,0.18)', label: '', chip: '' }
    };

    // ── Viz-type glyphs (make a box look like the panel it represents) ──

    function svgEl(tag, attrs) {
        var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
        return n;
    }

    function vizGlyph(type) {
        type = (type || '').toLowerCase();
        var stroke = 'rgba(255,255,255,0.32)';
        var svg = svgEl('svg', { viewBox: '0 0 100 60', preserveAspectRatio: 'xMidYMid meet', 'class': 'dpd-glyph' });
        function add(tag, a) { svg.appendChild(svgEl(tag, a)); }
        if (/single/.test(type)) {
            var t = svgEl('text', { x: 50, y: 40, 'text-anchor': 'middle', 'font-size': 34, 'font-family': 'sans-serif', 'font-weight': 'bold', fill: stroke });
            t.textContent = '42'; svg.appendChild(t);
        } else if (/area/.test(type)) {
            add('polygon', { points: '2,46 22,30 40,38 58,16 76,24 98,8 98,58 2,58', fill: stroke, 'fill-opacity': 0.18, stroke: 'none' });
            add('polyline', { points: '2,46 22,30 40,38 58,16 76,24 98,8', fill: 'none', stroke: stroke, 'stroke-width': 2.5 });
        } else if (/line|scatter|bubble/.test(type)) {
            if (/scatter|bubble/.test(type)) {
                var pts = [[20, 40, 5], [40, 20, 7], [60, 34, 4], [78, 16, 6], [50, 48, 3]];
                for (var s = 0; s < pts.length; s++) add('circle', { cx: pts[s][0], cy: pts[s][1], r: pts[s][2], fill: stroke, 'fill-opacity': 0.45 });
            } else {
                add('polyline', { points: '2,46 22,30 40,38 58,15 76,24 98,7', fill: 'none', stroke: stroke, 'stroke-width': 3 });
            }
        } else if (/bar|column/.test(type)) {
            var xs = [8, 30, 52, 74], hs = [28, 46, 18, 38];
            for (var i = 0; i < xs.length; i++) add('rect', { x: xs[i], y: 56 - hs[i], width: 16, height: hs[i], rx: 1, fill: stroke, 'fill-opacity': 0.5 });
        } else if (/pie|donut|radial/.test(type)) {
            add('circle', { cx: 50, cy: 30, r: 20, fill: 'none', stroke: stroke, 'stroke-opacity': 0.22, 'stroke-width': 7 });
            add('circle', { cx: 50, cy: 30, r: 20, fill: 'none', stroke: stroke, 'stroke-width': 7, 'stroke-dasharray': '72 200', transform: 'rotate(-90 50 30)' });
        } else if (/gauge|marker|filler/.test(type)) {
            add('path', { d: 'M14,50 A36,36 0 0,1 86,50', fill: 'none', stroke: stroke, 'stroke-opacity': 0.22, 'stroke-width': 7 });
            add('path', { d: 'M14,50 A36,36 0 0,1 60,17', fill: 'none', stroke: stroke, 'stroke-width': 7 });
        } else if (/table|event/.test(type)) {
            for (var r = 0; r < 4; r++) add('rect', { x: 6, y: 7 + r * 13, width: 88, height: 8, rx: 1, fill: stroke, 'fill-opacity': r === 0 ? 0.5 : 0.22 });
        } else if (/markdown/.test(type)) {
            var ws = [82, 58, 74, 44];
            for (var m = 0; m < 4; m++) add('rect', { x: 6, y: 9 + m * 12, width: ws[m], height: 5, rx: 2, fill: stroke, 'fill-opacity': 0.3 });
        } else if (/map|choropleth/.test(type)) {
            add('path', { d: 'M20,42 Q30,10 50,20 Q76,28 82,12 Q92,42 60,49 Q30,56 20,42 Z', fill: stroke, 'fill-opacity': 0.18, stroke: stroke, 'stroke-width': 1.5 });
        } else {
            add('rect', { x: 6, y: 8, width: 40, height: 18, rx: 2, fill: stroke, 'fill-opacity': 0.2 });
            add('rect', { x: 54, y: 8, width: 40, height: 18, rx: 2, fill: stroke, 'fill-opacity': 0.2 });
            add('rect', { x: 6, y: 32, width: 88, height: 20, rx: 2, fill: stroke, 'fill-opacity': 0.12 });
        }
        return svg;
    }

    // ── Visualization Class ─────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('dashboard-diff-viz');

            this.toolbar = el('div', 'ddv-toolbar');
            this.el.appendChild(this.toolbar);

            this.content = el('div', 'ddv-content');
            this.el.appendChild(this.content);

            this.board = el('div', 'dashboard-diff-viz__board');
            this.content.appendChild(this.board);

            this.drawer = el('div', 'dashboard-diff-viz__drawer');
            this.content.appendChild(this.drawer);

            this.overlay = el('div', 'dashboard-diff-viz__overlay');
            this.el.appendChild(this.overlay);

            this._lastRenderKey = null;
            this._removed = false;
            this._ui = null;  // live toggles {labels, changeList, sourceDiff} — override formatter defaults

            this._showPlaceholder('Awaiting data', 'Provide two dashboard versions (older + newer) to compare.');
        },

        getInitialDataParams: function() {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 50 };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                return { empty: true, colIdx: {}, rows: [] };
            }
            var fields = data.fields || [], colIdx = {};
            for (var i = 0; i < fields.length; i++) colIdx[fields[i].name] = i;
            return { empty: false, colIdx: colIdx, rows: data.rows };
        },

        updateView: function(data, config) {
            if (!data) { return; }

            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var c = {
                dataField:     config[ns + 'dataField'] || 'data',
                roleField:     config[ns + 'roleField'] || 'role',
                baselineValue: config[ns + 'baselineValue'] || 'baseline',
                targetValue:   config[ns + 'targetValue'] || 'target',
                showChangeList:(config[ns + 'showChangeList'] || 'true') === 'true',
                showSourceDiff:(config[ns + 'showSourceDiff'] || 'false') === 'true',
                showLabels:    (config[ns + 'showLabels'] || 'true') === 'true',
                showSplit:     (config[ns + 'showSplit'] || 'false') === 'true',
                showLive:      (config[ns + 'showLive'] || 'false') === 'true',
                liveMock:      (config[ns + 'liveMock'] || 'true') === 'true',
                bg:            config[ns + 'background'] || 'transparent'
            };

            this.el.style.background = c.bg;

            // Initialise live toggle state from the formatter defaults once;
            // after that the in-viz buttons own it.
            if (!this._ui) this._ui = { labels: c.showLabels, changeList: c.showChangeList, sourceDiff: c.showSourceDiff, split: c.showSplit, live: c.showLive };

            if (data.empty || !data.rows || data.rows.length === 0) {
                this._lastRenderKey = null;
                this._showPlaceholder('Awaiting data', 'No rows from the search yet.');
                return;
            }
            if (data.colIdx[c.dataField] === undefined) {
                this._lastRenderKey = null;
                this._showPlaceholder('Source column not found',
                    'Field "' + c.dataField + '" not in results. Columns: ' + Object.keys(data.colIdx).join(', '));
                return;
            }

            var pick = this._pickVersions(data, c);
            if (!pick.targetXml) {
                this._lastRenderKey = null;
                this._showPlaceholder('Need a newer version', 'Could not resolve the newer dashboard source.');
                return;
            }

            // Full-content hashes so same-length mid-content edits produce
            // a different key and trigger a re-render (D3 fix).
            var renderKey = hashString(pick.baselineXml || '') + ':' + hashString(pick.targetXml) + ':' +
                (this._ui.labels ? 1 : 0) + (this._ui.changeList ? 1 : 0) +
                (this._ui.sourceDiff ? 1 : 0) + (this._ui.split ? 1 : 0) + (this._ui.live ? 1 : 0);
            this._pending = { c: c, pick: pick };
            if (renderKey === this._lastRenderKey && this.board.firstChild) {
                this._reflowBoard();
                return;
            }
            this._lastRenderKey = renderKey;
            this._render();
        },

        _pickVersions: function(data, c) {
            var rows = data.rows, colIdx = data.colIdx;
            var dF = colIdx[c.dataField], rF = colIdx[c.roleField];
            var tF = colIdx['_time'];  // Splunk standard time field; may be absent
            var baselineXml = '', targetXml = '', baselineTime = '', targetTime = '';
            if (rF !== undefined) {
                for (var i = 0; i < rows.length; i++) {
                    var role = String(rows[i][rF] == null ? '' : rows[i][rF]).trim().toLowerCase();
                    if (role === String(c.baselineValue).trim().toLowerCase() && !baselineXml) {
                        baselineXml = rows[i][dF];
                        if (tF !== undefined) baselineTime = String(rows[i][tF] == null ? '' : rows[i][tF]);
                    }
                    if (role === String(c.targetValue).trim().toLowerCase() && !targetXml) {
                        targetXml = rows[i][dF];
                        if (tF !== undefined) targetTime = String(rows[i][tF] == null ? '' : rows[i][tF]);
                    }
                }
            }
            // Fallback: row 0 = target (newest), row 1 = baseline.
            if (!targetXml) {
                targetXml = rows[0][dF];
                if (tF !== undefined) targetTime = String(rows[0][tF] == null ? '' : rows[0][tF]);
            }
            if (!baselineXml && rows.length > 1) {
                baselineXml = rows[1][dF];
                if (tF !== undefined) baselineTime = String(rows[1][tF] == null ? '' : rows[1][tF]);
            }
            return { baselineXml: baselineXml, targetXml: targetXml, baselineTime: baselineTime, targetTime: targetTime };
        },

        // ── render ──────────────────────────────────────────────

        _render: function() {
            var p = this._pending; if (!p) return;
            var c = p.c;
            this._hideOverlay();

            var kind = detectKind(p.pick.targetXml);
            var changes, model, baselineModel = null;
            // Parse each Studio definition ONCE per _render call.
            var tDef = null, bDef = null;
            if (kind === 'studio') {
                tDef = extractStudioDefinition(p.pick.targetXml);
                bDef = p.pick.baselineXml ? extractStudioDefinition(p.pick.baselineXml) : null;
                if (!tDef) {
                    this._showPlaceholder('Could not parse Studio source',
                        'The newer version looks like Dashboard Studio but its <definition> JSON could not be parsed.');
                    return;
                }
                changes = (p.pick.baselineXml && bDef) ? diffStudio(bDef, tDef) : [];
                model = buildStudioSchematic(tDef);
                if (bDef) baselineModel = buildStudioSchematic(bDef);
            } else if (kind === 'sxml') {
                changes = p.pick.baselineXml ? diffSxml(p.pick.baselineXml, p.pick.targetXml) : [];
                model = buildSxmlSchematic(parseSxmlRows(p.pick.targetXml));
                if (p.pick.baselineXml) baselineModel = buildSxmlSchematic(parseSxmlRows(p.pick.baselineXml));
            } else {
                this._showPlaceholder('Unrecognized source',
                    'The newer version source is neither Dashboard Studio (version 2) nor Classic Simple XML.');
                return;
            }

            this._model = model;
            this._baselineModel = baselineModel;
            this._kind = kind;
            this._changes = changes;
            // Studio definition kept for the optional live (real-component) render.
            // Re-use the already-parsed tDef — no second extractStudioDefinition call.
            this._targetDef = (kind === 'studio') ? tDef : null;

            // Map diff kind onto TARGET panels (right/single view): everything
            // except removed (removed panels don't exist in the target).
            var kindById = {}, changeById = {};
            // Map diff kind onto BASELINE panels (left/split view): everything
            // except added (added panels don't exist in the baseline). Moved &
            // changed panels are shown at their OLD position here.
            var baseKindById = {}, baseChangeById = {};
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (ch.kind !== 'removed') { kindById[ch.id] = ch.kind; changeById[ch.id] = ch; }
                if (ch.kind !== 'added')   { baseKindById[ch.id] = ch.kind; baseChangeById[ch.id] = ch; }
            }
            this._kindById = kindById;
            this._changeById = changeById;
            this._baseKindById = baseKindById;
            this._baseChangeById = baseChangeById;

            // Render the drawer BEFORE the board: the board measures the width
            // left over after the drawer, so the drawer's show/hide state must
            // be applied first or the schematic scales to a stale width.
            this._renderToolbar();
            this._renderDrawer();
            this._renderBoard();
        },

        // In-viz control bar: title + kind + counts, live toggles, legend.
        _renderToolbar: function() {
            var self = this, changes = this._changes, p = this._pending;
            clear(this.toolbar);

            var counts = { added: 0, removed: 0, changed: 0, moved: 0 };
            for (var i = 0; i < changes.length; i++) counts[changes[i].kind]++;

            // Left: dashboard identity + diff summary.
            var left = el('div', 'ddv-toolbar__left');
            var title = '';
            if (this._kind === 'studio') {
                // Re-use the parsed definition stored by _render — no extra parse.
                title = (this._targetDef && this._targetDef.title) || '';
            } else {
                var lm = p.pick.targetXml.match(/<label[^>]*>([\s\S]{0,200}?)<\/label>/i);
                title = lm ? lm[1].replace(/\s+/g, ' ').trim() : '';
            }
            left.appendChild(el('span', 'ddv-title', title || '(untitled dashboard)'));
            left.appendChild(el('span', 'ddv-kind', this._kind === 'studio' ? 'Dashboard Studio' : 'Simple XML'));
            var summary = el('span', 'ddv-summary');
            function sumChip(k, n) { if (n) { var s = el('span', 'dpd-chip ' + KIND_COLORS[k].chip, KIND_COLORS[k].label + ' ' + n); summary.appendChild(s); } }
            sumChip('added', counts.added); sumChip('changed', counts.changed); sumChip('moved', counts.moved); sumChip('removed', counts.removed);
            if (!changes.length) summary.appendChild(el('span', 'dpd-chip dpd-chip--none', p.pick.baselineXml ? 'NO CHANGES' : 'NO OLDER VERSION'));
            left.appendChild(summary);
            this.toolbar.appendChild(left);

            // Right: toggle buttons.
            var right = el('div', 'ddv-toolbar__right');
            function toggleBtn(label, key) {
                var b = el('button', 'ddv-btn' + (self._ui[key] ? ' ddv-btn--on' : ''), label);
                b.addEventListener('click', function() {
                    self._ui[key] = !self._ui[key];
                    self._lastRenderKey = null; // force re-render
                    self._renderToolbar();
                    self._renderDrawer();  // apply drawer width first…
                    self._renderBoard();   // …so the board scales to what's left
                });
                return b;
            }
            // Live render shows the real Studio components (data-less). Studio only.
            if (this._kind === 'studio' && this._targetDef) right.appendChild(toggleBtn('Live render', 'live'));
            // Split needs a baseline to put on the left; only offer it then.
            if (p.pick.baselineXml && this._baselineModel) right.appendChild(toggleBtn('Split', 'split'));
            right.appendChild(toggleBtn('Labels', 'labels'));
            right.appendChild(toggleBtn('Change list', 'changeList'));
            right.appendChild(toggleBtn('Source diff', 'sourceDiff'));
            this.toolbar.appendChild(right);
        },

        // Build one scaled-to-fit schematic: a sizer wrapper (lays out at the
        // scaled size) holding an absolutely-positioned canvas (drawn at native
        // size, shrunk via CSS transform so titles/glyphs scale with it).
        // Registers itself in this._canvases for _reflowBoard.
        _buildCanvas: function(model, kindById, changeById) {
            var wrap = el('div', 'dpd-canvas-wrap');
            var canvas = el('div', 'dashboard-diff-viz__canvas');
            wrap.appendChild(canvas);

            for (var i = 0; i < model.panels.length; i++) {
                var pn = model.panels[i];
                var kind = kindById[pn.id] || 'same';
                var box = el('div', 'dpd-panel dpd-panel--' + kind);
                box.setAttribute('data-x', pn.x); box.setAttribute('data-y', pn.y);
                box.setAttribute('data-w', pn.w); box.setAttribute('data-h', pn.h);
                box.style.borderColor = KIND_COLORS[kind].border;
                if (kind !== 'same') box.style.boxShadow = 'inset 0 0 24px ' + KIND_COLORS[kind].border + '22';

                if (KIND_COLORS[kind].label) {
                    var badge = el('span', 'dpd-panel__badge', KIND_COLORS[kind].label);
                    badge.style.background = KIND_COLORS[kind].border;
                    box.appendChild(badge);
                }

                var pInner = el('div', 'dpd-panel__inner');
                if (this._ui.labels) {
                    var head = el('div', 'dpd-panel__head');
                    head.appendChild(el('div', 'dpd-panel__title', pn.title || '(untitled)'));
                    if (pn.vizType) head.appendChild(el('span', 'dpd-panel__type', pn.vizType));
                    pInner.appendChild(head);
                }
                var glyphWrap = el('div', 'dpd-panel__glyph');
                glyphWrap.appendChild(vizGlyph(pn.vizType));
                pInner.appendChild(glyphWrap);
                box.appendChild(pInner);

                // Rich hover: title, type, and what changed.
                var tip = (pn.title || '(untitled)') + (pn.vizType ? '  ·  ' + pn.vizType : '');
                var chg = changeById[pn.id];
                if (chg) { tip += '\n[' + KIND_COLORS[chg.kind].label + '] ' + chg.details.join('; '); }
                box.title = tip;
                canvas.appendChild(box);
            }

            this._canvases.push({ wrap: wrap, canvas: canvas, model: model });
            return wrap;
        },

        _renderBoard: function() {
            this._unmountLive();
            clear(this.board);
            this._canvases = [];

            // Live (real-component) render takes over the whole board. Studio only.
            if (this._ui.live && this._kind === 'studio' && this._targetDef) {
                this._renderLive();
                return;
            }

            var split = this._ui.split && this._pending.pick.baselineXml && this._baselineModel;

            if (split) {
                var row = el('div', 'dpd-split');
                row.appendChild(this._buildColumn('Older version', this._pending.pick.baselineTime,
                    this._baselineModel, this._baseKindById, this._baseChangeById));
                row.appendChild(this._buildColumn('Newer version', this._pending.pick.targetTime,
                    this._model, this._kindById, this._changeById));
                this.board.appendChild(row);
            } else {
                this.board.appendChild(this._buildCanvas(this._model, this._kindById, this._changeById));

                // Single view: removed panels (absent from the target) get a
                // ghost strip. In split view they show in the Baseline column.
                var removed = [];
                for (var r = 0; r < this._changes.length; r++) if (this._changes[r].kind === 'removed') removed.push(this._changes[r]);
                if (removed.length) {
                    var ghost = el('div', 'dpd-ghosts');
                    ghost.appendChild(el('span', 'dpd-ghosts__lead', 'Removed:'));
                    for (var g = 0; g < removed.length; g++) ghost.appendChild(el('span', 'dpd-ghost', removed[g].label));
                    this.board.appendChild(ghost);
                }
            }
            this._reflowBoard();
            // Widths can still be settling on first paint / after a drawer
            // toggle — re-measure on the next frame so the scale is correct.
            var self = this;
            if (typeof window !== 'undefined' && window.requestAnimationFrame) {
                window.requestAnimationFrame(function() { self._reflowBoard(); });
            }
        },

        // Mount the real Splunk Dashboard Studio component tree, data-less.
        // live_render (+ React + dashboard-core) is fetched as a LAZY async
        // chunk — only downloaded the first time the user enables "Live render".
        // The entry visualization.js stays lean (~schematic-only) for everyone
        // who never toggles it on.
        _renderLive: function() {
            var self = this;
            var def = this._targetDef;
            var lw = (def.layout && def.layout.options && def.layout.options.width) || 1200;
            var lh = (def.layout && def.layout.options && def.layout.options.height) || 600;

            // host (fills board width) > scaler (native size, CSS-scaled to fit)
            //   > reactHost (DashboardCore mounts here) + overlay (diff boxes)
            var host = el('div', 'dpd-live');
            var scaler = el('div', 'dpd-live__scaler');
            scaler.style.width = lw + 'px';
            scaler.style.height = lh + 'px';
            var reactHost = el('div', 'dpd-live__react');
            scaler.appendChild(reactHost);
            host.appendChild(scaler);
            this.board.appendChild(host);

            // Show a loading indicator while the async chunk is fetching.
            var loadingMsg = el('div', 'dpd-live-loading');
            loadingMsg.appendChild(el('div', 'dashboard-diff-viz__ph-head', 'Loading live renderer…'));
            loadingMsg.appendChild(el('div', 'dashboard-diff-viz__ph-detail', 'Downloading Dashboard Studio components (one-time, ~3 MB).'));
            reactHost.appendChild(loadingMsg);

            // Capture the render-key at launch; if the user toggles away before
            // the chunk arrives we skip mounting into a stale/removed host.
            var launchKey = this._lastRenderKey;

            import(/* webpackChunkName: "live_render" */ './live_render').then(function(lrModule) {
                // Bail if the viz has been removed (panel torn down) or re-rendered
                // since we fired the import. _removed must be checked first because
                // remove() nulls _lastRenderKey to null and launchKey is also null on
                // the toolbar-toggle path — null !== null is false, so the old guard
                // alone cannot catch the post-remove case (V1 fix).
                if (self._removed) return;
                if (self._lastRenderKey !== launchKey || !self.board.contains(host)) return;

                var lr = (lrModule && lrModule.__esModule) ? (lrModule.default || lrModule) : lrModule;
                // Clear the loading indicator before mounting React.
                while (reactHost.firstChild) reactHost.removeChild(reactHost.firstChild);

                try {
                    self._liveRoot = lr.mount(reactHost, def, self._pending.c.liveMock);
                } catch (e) {
                    if (self.board.contains(host)) self.board.removeChild(host);
                    var msg = el('div', 'dpd-live-error');
                    msg.appendChild(el('div', 'dashboard-diff-viz__ph-head', 'Live render failed'));
                    msg.appendChild(el('div', 'dashboard-diff-viz__ph-detail',
                        'Could not mount the dashboard components: ' + (e && e.message ? e.message : e) +
                        '. Turn Live render off to return to the schematic.'));
                    self.board.appendChild(msg);
                    return;
                }

                // Diff overlay: colour-coded borders on the real panels, positioned
                // from the layout (same viz ids the diff uses). Removed panels can't
                // be shown here (absent from the target) — they stay in the toolbar.
                var overlay = el('div', 'dpd-live__overlay');
                var posMap = {};
                collectPositions(def.layout || {}, posMap);
                for (var id in self._kindById) {
                    if (!Object.prototype.hasOwnProperty.call(self._kindById, id)) continue;
                    var pos = posMap[id];
                    if (!pos || typeof pos.x !== 'number') continue;
                    var kind = self._kindById[id];
                    var bx = el('div', 'dpd-live-box dpd-live-box--' + kind);
                    bx.style.left = pos.x + 'px'; bx.style.top = pos.y + 'px';
                    bx.style.width = (pos.w || 100) + 'px'; bx.style.height = (pos.h || 100) + 'px';
                    bx.style.borderColor = KIND_COLORS[kind].border;
                    if (KIND_COLORS[kind].label) {
                        var badge = el('span', 'dpd-live-box__badge', KIND_COLORS[kind].label);
                        badge.style.background = KIND_COLORS[kind].border;
                        bx.appendChild(badge);
                    }
                    overlay.appendChild(bx);
                }
                scaler.appendChild(overlay);

                self._liveDims = { lw: lw, lh: lh, host: host, scaler: scaler };
                self._reflowLive();
                if (typeof window !== 'undefined' && window.requestAnimationFrame) {
                    window.requestAnimationFrame(function() { self._reflowLive(); });
                }

            }).catch(function(err) {
                // Bail if the viz has been removed while the chunk was loading (V1 fix).
                if (self._removed) return;
                // Chunk fetch failed (network error, 404, etc.) — revert the
                // Live render toggle and show a useful message.
                if (self._ui) self._ui.live = false;
                if (self.board.contains(host)) self.board.removeChild(host);
                var msg = el('div', 'dpd-live-error');
                msg.appendChild(el('div', 'dashboard-diff-viz__ph-head', 'Live render unavailable'));
                msg.appendChild(el('div', 'dashboard-diff-viz__ph-detail',
                    'Could not load the live-render module: ' +
                    (err && err.message ? err.message : String(err)) +
                    '. Turn Live render off to return to the schematic.'));
                self.board.appendChild(msg);
            });

            // Record live dims with null scaler so _reflowLive is a no-op until
            // the async chunk resolves and sets the real dims.
            this._liveDims = null;
        },

        // Scale the native-size live dashboard to fill the board width.
        _reflowLive: function() {
            var d = this._liveDims;
            if (!d) return;
            var avail = Math.max(120, (this.board.clientWidth || 600) - 4);
            var scale = avail / d.lw;
            if (scale > 2) scale = 2; // don't upscale into mush
            d.scaler.style.transform = 'scale(' + scale + ')';
            d.scaler.style.transformOrigin = 'top left';
            d.host.style.width = (d.lw * scale) + 'px';
            d.host.style.height = (d.lh * scale) + 'px';
        },

        _unmountLive: function() {
            if (this._liveRoot) {
                // _liveRoot is a React root (ReactDOMClient.createRoot return value).
                // Call unmount directly — no need to re-import the async chunk.
                try {
                    if (typeof this._liveRoot.unmount === 'function') this._liveRoot.unmount();
                } catch (e) { /* ignore */ }
                this._liveRoot = null;
            }
            this._liveDims = null;
        },

        _buildColumn: function(label, sub, model, kindById, changeById) {
            var col = el('div', 'dpd-col');
            var head = el('div', 'dpd-col__head');
            head.appendChild(el('span', 'dpd-col__name', label));
            head.appendChild(el('span', 'dpd-col__sub', sub));
            col.appendChild(head);
            col.appendChild(this._buildCanvas(model, kindById, changeById));
            return col;
        },

        // Scale every registered canvas to the width of its own container.
        _reflowBoard: function() {
            if (!this._canvases || !this._canvases.length) return;
            for (var ci = 0; ci < this._canvases.length; ci++) {
                var entry = this._canvases[ci], model = entry.model;
                var parent = entry.wrap.parentNode;
                var avail = Math.max(120, (parent ? parent.clientWidth : 600) - 4);
                var cw = model.canvasW, ch = model.canvasH;
                var scale = avail / cw;
                if (scale > 1) scale = 1;
                // Never shrink past readability — below this, let the board
                // scroll instead of rendering an unreadably tiny schematic.
                if (scale < 0.45) scale = 0.45;

                entry.canvas.style.width = cw + 'px';
                entry.canvas.style.height = ch + 'px';
                entry.canvas.style.transform = 'scale(' + scale + ')';
                entry.canvas.style.transformOrigin = 'top left';
                // The wrapper occupies the SCALED size so layout/scroll are correct.
                entry.wrap.style.width = (cw * scale) + 'px';
                entry.wrap.style.height = (ch * scale) + 'px';

                var boxes = entry.canvas.childNodes;
                for (var i = 0; i < boxes.length; i++) {
                    var b = boxes[i];
                    if (!b.getAttribute) continue;
                    b.style.left = b.getAttribute('data-x') + 'px';
                    b.style.top = b.getAttribute('data-y') + 'px';
                    b.style.width = b.getAttribute('data-w') + 'px';
                    b.style.height = b.getAttribute('data-h') + 'px';
                }
            }
        },

        _renderDrawer: function() {
            var c = this._pending.c, changes = this._changes, kind = this._kind, p = this._pending;
            var show = this._ui.changeList || this._ui.sourceDiff;
            this.drawer.style.display = show ? 'flex' : 'none';
            this.el.classList.toggle('dashboard-diff-viz--with-drawer', show);
            if (!show) { clear(this.drawer); return; }
            clear(this.drawer);

            var counts = { added: 0, removed: 0, changed: 0, moved: 0 };
            for (var i = 0; i < changes.length; i++) counts[changes[i].kind]++;
            var header = el('div', 'dpd-drawer__header');
            header.appendChild(el('div', 'dpd-drawer__title', 'Diff vs older version'));
            var chips = el('div', 'dpd-drawer__chips');
            function chip(k, n) { if (n) { var s = el('span', 'dpd-chip ' + KIND_COLORS[k].chip, KIND_COLORS[k].label + ' ' + n); chips.appendChild(s); } }
            chip('added', counts.added); chip('changed', counts.changed); chip('moved', counts.moved); chip('removed', counts.removed);
            if (!changes.length) chips.appendChild(el('span', 'dpd-chip dpd-chip--none', p.pick.baselineXml ? 'NO CHANGES' : 'NO OLDER VERSION'));
            header.appendChild(chips);
            this.drawer.appendChild(header);

            var body = el('div', 'dpd-drawer__body');
            this.drawer.appendChild(body);

            if (this._ui.changeList) {
                var list = el('div', 'dpd-changelist');
                if (!changes.length) list.appendChild(el('div', 'dpd-changelist__empty',
                    p.pick.baselineXml ? 'The two versions are structurally identical.' : 'Only one version supplied — showing layout only.'));
                for (var j = 0; j < changes.length; j++) {
                    var ch = changes[j], item = el('div', 'dpd-change dpd-change--' + ch.kind);
                    var head = el('div', 'dpd-change__head');
                    head.appendChild(el('span', 'dpd-chip ' + KIND_COLORS[ch.kind].chip, KIND_COLORS[ch.kind].label));
                    head.appendChild(el('span', 'dpd-change__label', ch.label));
                    item.appendChild(head);
                    for (var d = 0; d < ch.details.length; d++) item.appendChild(el('div', 'dpd-change__detail', ch.details[d]));
                    list.appendChild(item);
                }
                body.appendChild(list);
            }

            if (this._ui.sourceDiff && p.pick.baselineXml) {
                var dl = lineDiff(prettyForDiff(p.pick.baselineXml, kind), prettyForDiff(p.pick.targetXml, kind));
                var pre = el('div', 'dpd-srcdiff'), addN = 0, delN = 0, cap = 4000;
                for (var k = 0; k < dl.length && k < cap; k++) {
                    var ln = dl[k], row = el('div', 'dpd-srcdiff__line dpd-srcdiff__line--' + ln.type);
                    var sign = ln.type === 'add' ? '+' : (ln.type === 'del' ? '-' : (ln.type === 'info' ? '!' : ' '));
                    row.appendChild(el('span', 'dpd-srcdiff__sign', sign));
                    row.appendChild(el('span', 'dpd-srcdiff__text', ln.text));
                    pre.appendChild(row);
                    if (ln.type === 'add') addN++; if (ln.type === 'del') delN++;
                }
                var sh = el('div', 'dpd-drawer__subhead');
                sh.appendChild(el('span', null, 'Source diff'));
                sh.appendChild(el('span', 'dpd-srcdiff__stat', '+' + addN + ' −' + delN));
                body.appendChild(sh);
                body.appendChild(pre);
            }
        },

        _hideOverlay: function() { this.overlay.style.display = 'none'; clear(this.overlay); },

        _showPlaceholder: function(headline, detail) {
            clear(this.overlay);
            this.overlay.style.display = 'flex';
            this.overlay.appendChild(el('div', 'dashboard-diff-viz__ph-head', headline));
            this.overlay.appendChild(el('div', 'dashboard-diff-viz__ph-detail', detail));
        },

        reflow: function() { this._reflowBoard(); this._reflowLive(); },

        remove: function() {
            this._removed = true;
            this._unmountLive();
            this._lastRenderKey = null;
            this._targetDef = null;
            this._model = null;
            this._baselineModel = null;
            this._changes = null;
            this._pending = null;
            this._kindById = null;
            this._changeById = null;
            this._baseKindById = null;
            this._baseChangeById = null;
            this._canvases = null;
            if (SplunkVisualizationBase.prototype.remove) {
                SplunkVisualizationBase.prototype.remove.apply(this, arguments);
            }
        }
    });
});
