/*
 * Dashboard Preview + Diff - Splunk Custom Visualization
 *
 * Renders a saved Splunk dashboard (Dashboard Studio or Classic Simple XML)
 * from its raw eai:data XML envelope, and overlays a visual DIFF between two
 * versions of that dashboard's source.
 *
 * Use case: snapshot a dashboard's eai:data into a summary index over time.
 * Pick two snapshots (baseline + target) with two dropdown tokens. The viz
 * renders the TARGET version and highlights what changed vs the BASELINE:
 *   - in-iframe highlight boxes over added / changed / moved panels
 *   - a structural change list
 *   - a line-by-line source diff
 *   - (experimental) a blend onion-skin overlay of both renders
 * Each of the four is independently toggleable.
 *
 * Security model:
 *   - Writes only ever land in THIS app ('ko_history') — never the user's
 *     search app or anywhere configurable.
 *   - Every new write is gated behind an in-panel approval card.
 *   - The BASELINE is normally only parsed in memory (no write). It is only
 *     written when the experimental blend mode is enabled.
 */
define([
    'api/SplunkVisualizationBase'
], function(SplunkVisualizationBase) {

    // This viz ships inside the ko_history app, so preview slots are written
    // into ko_history's own data/ui/views. Never user-configurable.
    var PREVIEW_APP = 'ko_history';

    // ── Per-user slot suffix ────────────────────────────────────
    // Compute once at viz load time.  window.$C.USERNAME is set by Splunk Web on
    // every dashboard page.  Sanitize to [a-z0-9_-] for safe view-name use.
    // Falls back to '' (empty) so the unsuffixed name is used when unavailable.
    function _sanitizeUsername(u) {
        if (!u || typeof u !== 'string') return '';
        return u.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    }
    var _userSuffix = (function() {
        try {
            var u = (window.$C && window.$C.USERNAME) || '';
            var s = _sanitizeUsername(u);
            return s ? '_' + s : '';
        } catch (e) { return ''; }
    }());
    // Sanitized username without the leading underscore — used for {user}
    // substitution in custom previewSlot values.
    var _sanitizedUser = _userSuffix ? _userSuffix.slice(1) : '';

    // Default previewSlot — per-user so concurrent compares don't collide.
    // Custom slot names (via formatter config) may include the literal token
    // {user}, which the viz replaces with the sanitized current username — e.g.
    // kohist_current_{user}. Without {user} the value is used as-is (today's
    // behavior). Only this default is automatically suffixed.
    var DEFAULT_PREVIEW_SLOT = 'dashboard_preview_slot' + _userSuffix;

    // ── Generic pure helpers ────────────────────────────────────

    // 64-bit-equivalent approval-gate key: two independent 32-bit hashes
    // (djb2 + FNV-1a) concatenated as base36 strings. Pure synchronous ES5 —
    // no Math.imul / crypto.subtle. FNV-1a multiply is split into two 16-bit
    // halves to stay within safe-integer range. Keys are page-lifetime only,
    // so the format change is non-breaking.
    function hashString(s) {
        if (!s) return '0_0';
        // djb2 (seed 5381)
        var h1 = 5381;
        // FNV-1a 32-bit (offset basis 2166136261, prime 16777619)
        var h2 = 2166136261;
        var FNV_PRIME = 16777619;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            // djb2: h = h * 33 + c (bit-masked to 32 bits)
            h1 = (((h1 << 5) + h1) + c) | 0;
            // FNV-1a: h = (h XOR c) * FNV_PRIME — 32-bit via 16-bit split
            h2 = h2 ^ c;
            // Multiply h2 (uint32) by FNV_PRIME without overflow:
            // split h2 into lo/hi 16-bit halves, multiply each, recombine.
            var lo = (h2 & 0xFFFF) * FNV_PRIME;
            var hi = ((h2 >>> 16) * FNV_PRIME + (lo >>> 16)) & 0xFFFF;
            h2 = ((hi << 16) | (lo & 0xFFFF)) >>> 0;
        }
        return (h1 >>> 0).toString(36) + '_' + h2.toString(36);
    }

    // Bounded key-set helper for approval/rejection tracking (D6 fix).
    // Caps at maxSize entries by evicting the oldest (FIFO).
    // `order` is a parallel array that tracks insertion order for the `obj` map.
    function mapSet(obj, order, key, maxSize) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            order.push(key);
            if (order.length > maxSize) { delete obj[order.shift()]; }
        }
        obj[key] = true;
    }

    // True when the viz runs in a sandboxed iframe without allow-same-origin.
    // Dashboard Studio wraps classic custom visualizations this way, which
    // blocks cookie/CSRF access and same-origin writes — so the write-then-
    // iframe preview pattern cannot function there. Classic Simple XML
    // dashboards are NOT sandboxed, so the viz works normally there.
    function isSandboxed() {
        try { void document.cookie; return false; } catch (e) { return true; }
    }

    function getCsrfToken() {
        var raw;
        try { raw = document.cookie; } catch (e) { return ''; }
        var cookies = raw ? raw.split(';') : [];
        for (var i = 0; i < cookies.length; i++) {
            var c = cookies[i].replace(/^\s+/, '');
            if (c.indexOf('splunkweb_csrf_token') === 0) {
                var eq = c.indexOf('=');
                if (eq > 0) return decodeURIComponent(c.substring(eq + 1));
            }
        }
        return '';
    }

    function encodeForm(obj) {
        var parts = [];
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
            }
        }
        return parts.join('&');
    }

    // Derive the current Splunk locale from the page URL at call time.
    // window.location.pathname typically starts with /<locale>/app/...
    // Falls back to 'en-US' when the path is unexpected.
    function splunkLocale() {
        try {
            var segs = window.location.pathname.split('/').filter(Boolean);
            return (segs.length > 0 && segs[0]) ? segs[0] : 'en-US';
        } catch (e) { return 'en-US'; }
    }

    function splunkdUrl(path) { return '/' + splunkLocale() + '/splunkd/__raw' + path; }

    function viewsEndpoint(viewName) {
        return '/servicesNS/nobody/' + encodeURIComponent(PREVIEW_APP) + '/data/ui/views' +
               (viewName ? '/' + encodeURIComponent(viewName) : '');
    }

    function upsertView(viewName, xmlData) {
        var headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Splunk-Form-Key': getCsrfToken(),
            'X-Requested-With': 'XMLHttpRequest'
        };
        var updateUrl = splunkdUrl(viewsEndpoint(viewName)) + '?output_mode=json';
        return fetch(updateUrl, {
            method: 'POST', credentials: 'same-origin', headers: headers,
            body: encodeForm({ 'eai:data': xmlData })
        }).then(function(resp) {
            if (resp.ok) return resp;
            if (resp.status === 404) {
                var createUrl = splunkdUrl(viewsEndpoint()) + '?output_mode=json';
                return fetch(createUrl, {
                    method: 'POST', credentials: 'same-origin', headers: headers,
                    body: encodeForm({ 'name': viewName, 'eai:data': xmlData })
                }).then(function(r2) {
                    if (r2.ok) return r2;
                    return r2.text().then(function(t) {
                        throw new Error('Create view failed: HTTP ' + r2.status + ' ' + t.slice(0, 240));
                    });
                });
            }
            return resp.text().then(function(t) {
                throw new Error('Update view failed: HTTP ' + resp.status + ' ' + t.slice(0, 240));
            });
        });
    }

    function buildPreviewUrl(viewName, urlParams, cacheBuster) {
        var url = '/' + splunkLocale() + '/app/' + encodeURIComponent(PREVIEW_APP) + '/' + encodeURIComponent(viewName);
        var sep = '?';
        if (urlParams && urlParams.length) {
            url += sep + (urlParams.charAt(0) === '?' ? urlParams.slice(1) : urlParams);
            sep = '&';
        }
        return url + sep + '_cb=' + encodeURIComponent(cacheBuster);
    }

    // Reject after `ms` so a splunkd write that never responds (Dashboard
    // Studio sandbox, SSO redirect, proxy buffering) surfaces an error
    // instead of hanging the panel on "Writing…" forever.
    // Returns {promise, cancel} — caller MUST call cancel() when the write
    // wins the race so the timer is cleared (D7 fix).
    function rejectAfter(ms) {
        var timer;
        var p = new Promise(function(_resolve, reject) {
            timer = setTimeout(function() {
                reject(new Error('write timed out after ' + ms + 'ms. splunkd did not respond'));
            }, ms);
        });
        return { promise: p, cancel: function() { clearTimeout(timer); } };
    }

    // ── Source inspection / parsing ─────────────────────────────

    function detectKind(xml) {
        if (!xml || typeof xml !== 'string') return 'unknown';
        var vMatch = xml.match(/<dashboard[^>]*\bversion\s*=\s*["']([^"']+)["']/i);
        if (vMatch && vMatch[1] === '2') return 'studio';
        if (/<form[^>]*\bversion\s*=\s*["']2["']/i.test(xml)) return 'studio';
        if (/<dashboard\b/i.test(xml) || /<form\b/i.test(xml)) return 'sxml';
        // Bare JSON definition (some endpoints)
        var t = xml.replace(/^\s+/, '');
        if (t.charAt(0) === '{') return 'studio';
        return 'unknown';
    }

    function inspectSource(xml) {
        var info = { kind: 'Unknown', label: '', sizeKb: 0 };
        if (!xml || typeof xml !== 'string') return info;
        info.sizeKb = Math.round((xml.length / 1024) * 10) / 10;
        var k = detectKind(xml);
        info.kind = k === 'studio' ? 'Dashboard Studio' : (k === 'sxml' ? 'Classic Simple XML' : 'Unknown');
        var lMatch = xml.match(/<label[^>]*>([\s\S]{0,300}?)<\/label>/i);
        if (lMatch) info.label = lMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim();
        if (!info.label && k === 'studio') {
            var tm = xml.match(/"title"\s*:\s*"((?:[^"\\]|\\.){0,200})"/);
            if (tm) info.label = tm[1];
        }
        return info;
    }

    // Pull the Studio definition object out of the envelope.
    function extractStudioDefinition(xml) {
        if (!xml) return null;
        // 1) <definition> CDATA blob
        var m = xml.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
        var jsonText = null;
        if (m) {
            jsonText = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
        } else {
            // 2) maybe the whole thing is JSON
            var t = xml.replace(/^\s+/, '');
            if (t.charAt(0) === '{') jsonText = t;
        }
        if (!jsonText) return null;
        try { return JSON.parse(jsonText); } catch (e) { return null; }
    }

    function stableStringify(v) {
        // Order-independent JSON string for equality comparison.
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
        for (var j = 0; j < keys.length; j++) {
            parts.push(JSON.stringify(keys[j]) + ':' + stableStringify(v[keys[j]]));
        }
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

    // Find a viz's bound dataSource query (best effort) for change detail.
    function vizQuery(def, viz) {
        if (!viz || !viz.dataSources) return '';
        var dsId = viz.dataSources.primary;
        if (!dsId || !def.dataSources || !def.dataSources[dsId]) return '';
        return get(def.dataSources[dsId], ['options', 'query']) || '';
    }

    // ── Diff: Dashboard Studio (match by viz id) ────────────────

    function diffStudio(baseDef, targDef) {
        var changes = [];
        baseDef = baseDef || {};
        targDef = targDef || {};
        var bViz = baseDef.visualizations || {};
        var tViz = targDef.visualizations || {};

        // Layout positions by viz id.
        function posMap(def) {
            var map = {};
            var struct = get(def, ['layout', 'structure']) || [];
            for (var i = 0; i < struct.length; i++) {
                var it = struct[i];
                if (it && it.item) map[it.item] = it.position || {};
            }
            return map;
        }
        var bPos = posMap(baseDef), tPos = posMap(targDef);

        var seen = {};
        var id;
        for (id in tViz) {
            if (!Object.prototype.hasOwnProperty.call(tViz, id)) continue;
            seen[id] = true;
            var tv = tViz[id];
            var label = (tv && tv.title) || (tv && tv.type) || id;
            if (!Object.prototype.hasOwnProperty.call(bViz, id)) {
                changes.push({ id: id, label: label, kind: 'added', details: ['new panel (' + ((tv && tv.type) || '?') + ')'] });
                continue;
            }
            var bv = bViz[id];
            var details = [];
            // type
            if ((bv && bv.type) !== (tv && tv.type)) details.push('type: ' + (bv && bv.type) + ' → ' + (tv && tv.type));
            // title
            if ((bv && bv.title) !== (tv && tv.title) && ((bv && bv.title) || (tv && tv.title))) {
                details.push('title: "' + ((bv && bv.title) || '') + '" → "' + ((tv && tv.title) || '') + '"');
            }
            // options
            if (stableStringify(bv && bv.options) !== stableStringify(tv && tv.options)) details.push('options changed');
            // query
            var bq = vizQuery(baseDef, bv), tq = vizQuery(targDef, tv);
            if (bq !== tq) details.push('search changed');
            // position
            var bp = bPos[id] || {}, tp = tPos[id] || {};
            var moved = (bp.x !== tp.x) || (bp.y !== tp.y) || (bp.w !== tp.w) || (bp.h !== tp.h);
            if (details.length > 0) {
                changes.push({ id: id, label: label, kind: 'changed', details: details });
            } else if (moved) {
                changes.push({ id: id, label: label, kind: 'moved',
                    details: ['moved/resized (' + bp.x + ',' + bp.y + ' ' + bp.w + 'x' + bp.h +
                              ' → ' + tp.x + ',' + tp.y + ' ' + tp.w + 'x' + tp.h + ')'] });
            }
        }
        for (id in bViz) {
            if (!Object.prototype.hasOwnProperty.call(bViz, id)) continue;
            if (!seen[id]) {
                var rv = bViz[id];
                changes.push({ id: id, label: (rv && rv.title) || id, kind: 'removed', details: ['panel removed'] });
            }
        }
        return changes;
    }

    // ── Diff: Classic Simple XML (match by panel index) ─────────

    function parseSxmlPanels(xml) {
        var panels = [];
        try {
            var doc = new DOMParser().parseFromString(xml, 'text/xml');
            if (doc.getElementsByTagName('parsererror').length) return panels;
            var panelNodes = doc.getElementsByTagName('panel');
            for (var i = 0; i < panelNodes.length; i++) {
                var p = panelNodes[i];
                var titleNodes = p.getElementsByTagName('title');
                var title = titleNodes.length ? (titleNodes[0].textContent || '').trim() : '';
                var queries = p.getElementsByTagName('query');
                var qtext = [];
                for (var q = 0; q < queries.length; q++) qtext.push((queries[q].textContent || '').trim());
                // viz element types = direct-ish child element names that aren't title/search
                var types = [];
                var kids = p.childNodes;
                for (var c = 0; c < kids.length; c++) {
                    if (kids[c].nodeType === 1) {
                        var nm = kids[c].nodeName.toLowerCase();
                        if (nm !== 'title' && nm !== 'search') types.push(nm);
                    }
                }
                panels.push({ title: title, query: qtext.join(' || '), types: types.join(',') });
            }
        } catch (e) { /* tolerate */ }
        return panels;
    }

    function diffSxml(baseXml, targXml) {
        var changes = [];
        var b = parseSxmlPanels(baseXml);
        var t = parseSxmlPanels(targXml);
        var n = Math.max(b.length, t.length);
        for (var i = 0; i < n; i++) {
            var bp = b[i], tp = t[i];
            var label = (tp && tp.title) || (bp && bp.title) || ('panel ' + (i + 1));
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

    // Adapter: shared ops ({t,a,b}) → dashboard_preview format [{type,text}].
    // type: 'ctx' (unchanged), 'del', 'add', 'info' (degraded notice).
    function lineDiff(aText, bText) {
        var a = (aText || '').split('\n');
        var b = (bText || '').split('\n');
        var result = _lineDiffCore(a, b);
        if (result.degraded) {
            return [{ type: 'info', text: 'Source too large for line-by-line diff (' + a.length + ' vs ' + b.length + ' lines).' }];
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
        added:   { border: '#3fb950', label: 'ADDED',   chip: 'dp-chip--added' },
        changed: { border: '#d29922', label: 'CHANGED', chip: 'dp-chip--changed' },
        moved:   { border: '#58a6ff', label: 'MOVED',   chip: 'dp-chip--moved' },
        removed: { border: '#f85149', label: 'REMOVED', chip: 'dp-chip--removed' }
    };

    // ── Visualization Class ─────────────────────────────────────

    return SplunkVisualizationBase.extend({

        initialize: function() {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('dashboard-preview-viz');

            this.frameWrap = document.createElement('div');
            this.frameWrap.className = 'dashboard-preview-viz__frame-wrap';
            this.el.appendChild(this.frameWrap);

            // Baseline iframe (only used / shown in blend mode), underneath.
            this.baseIframe = document.createElement('iframe');
            this.baseIframe.className = 'dashboard-preview-viz__frame dashboard-preview-viz__frame--base';
            this.baseIframe.setAttribute('allowfullscreen', 'true');
            // NOTE: allow-scripts + allow-same-origin on a same-origin iframe is
            // effectively no sandbox (scripts can remove the sandbox attribute).
            // Real protection is: (1) server-side view sanitization — Splunk strips
            // executable content on write; (2) the explicit user approval gate before
            // any write. The attribute is kept to block top-navigation, popups, and
            // downloads from snapshot-derived content.
            this.baseIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
            this.baseIframe.src = 'about:blank';
            this.baseIframe.style.display = 'none';
            this.frameWrap.appendChild(this.baseIframe);

            // Target iframe (always the primary render).
            this.iframe = document.createElement('iframe');
            this.iframe.className = 'dashboard-preview-viz__frame dashboard-preview-viz__frame--target';
            this.iframe.setAttribute('allowfullscreen', 'true');
            // NOTE: allow-scripts + allow-same-origin on a same-origin iframe is
            // effectively no sandbox (scripts can remove the sandbox attribute).
            // Real protection is: (1) server-side view sanitization — Splunk strips
            // executable content on write; (2) the explicit user approval gate before
            // any write. The attribute is kept to block top-navigation, popups, and
            // downloads from snapshot-derived content.
            this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
            this.iframe.src = 'about:blank';
            this.frameWrap.appendChild(this.iframe);

            // Diff drawer (parent-side): change list + source diff.
            this.drawer = document.createElement('div');
            this.drawer.className = 'dashboard-preview-viz__drawer';
            this.el.appendChild(this.drawer);

            // Overlay for placeholders + approval.
            this.overlay = document.createElement('div');
            this.overlay.className = 'dashboard-preview-viz__overlay';
            this.el.appendChild(this.overlay);

            // State
            this._lastUrl = null;
            this._lastBaseUrl = null;
            this._lastScale = null;
            this._lastBg = null;
            this._approvedKeys = {};  this._approvedOrder = [];
            this._rejectedKeys = {};  this._rejectedOrder = [];
            this._inflightKey = null;
            this._writtenKey = null;       // write-key currently rendered
            this._lastDiffKey = null;      // diff inputs currently shown
            this._hlTimer = null;          // highlight injection poller
            this._lastChanges = null;
            this._overlayKey = null;       // tracks which key+state the overlay currently shows (V4)

            this._showPlaceholder('Awaiting data', 'Pick two dashboard versions to compare (older + newer).');
        },

        getInitialDataParams: function() {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 50 };
        },

        formatData: function(data) {
            if (!data || !data.rows || data.rows.length === 0) {
                return { empty: true, colIdx: {}, rows: [] };
            }
            var fields = data.fields || [];
            var colIdx = {};
            for (var i = 0; i < fields.length; i++) colIdx[fields[i].name] = i;
            var result = { empty: false, colIdx: colIdx, rows: data.rows };
            return result;
        },

        // ── main ────────────────────────────────────────────────

        updateView: function(data, config) {
            if (!data) { return; }

            var ns = this.getPropertyNamespaceInfo().propertyNamespace;
            var c = {
                dataField:    config[ns + 'dataField'] || 'data',
                roleField:    config[ns + 'roleField'] || 'role',
                baselineValue:config[ns + 'baselineValue'] || 'baseline',
                targetValue:  config[ns + 'targetValue'] || 'target',
                appField:     config[ns + 'appField'] || 'app',
                appDefault:   config[ns + 'appDefault'] || 'search',
                previewSlot:  (config[ns + 'previewSlot'] || DEFAULT_PREVIEW_SLOT).replace(/\{user\}/g, _sanitizedUser),
                baselineSlot: (config[ns + 'baselineSlot'] || 'dashboard_preview_slot_baseline').replace(/\{user\}/g, _sanitizedUser),
                urlParams:    config[ns + 'urlParams'] ||
                    'hideEdit=true&hideTitle=true&hideFilters=true&hideSplunkBar=true&hideFooter=true&hideAppBar=true&hideChrome=true',
                hlSelector:   config[ns + 'highlightSelector'] || '',
                showHighlights: (config[ns + 'showHighlights'] || 'true') === 'true',
                showChangeList: (config[ns + 'showChangeList'] || 'true') === 'true',
                showSourceDiff: (config[ns + 'showSourceDiff'] || 'false') === 'true',
                showBlend:      (config[ns + 'showBlend'] || 'false') === 'true',
                scale: parseFloat(config[ns + 'scale']),
                bg: config[ns + 'background'] || 'transparent'
            };
            if (isNaN(c.scale) || c.scale <= 0) c.scale = 1.0;

            this._applyChrome(c);

            if (data.empty || !data.rows || data.rows.length === 0) {
                this.iframe.style.visibility = 'hidden';
                this._showPlaceholder('Awaiting data', 'No rows from the search yet.');
                return;
            }
            if (data.colIdx[c.dataField] === undefined) {
                this.iframe.style.visibility = 'hidden';
                this._showPlaceholder('Source column not found',
                    'Field "' + c.dataField + '" not in results. Columns: ' + Object.keys(data.colIdx).join(', '));
                return;
            }

            // Hard platform stop: a sandboxed host (Dashboard Studio wraps
            // classic custom vizs in a sandbox without allow-same-origin)
            // cannot read cookies, authenticate the splunkd write, or expose
            // the preview iframe for highlighting. Fail clearly instead of
            // hanging on "Writing…".
            if (isSandboxed()) {
                this.iframe.style.visibility = 'hidden';
                this._showPlaceholder('Not supported in this dashboard',
                    'The host runs this visualization in a sandboxed iframe (Dashboard Studio does this), which blocks the same-origin write needed to render a preview. Use this visualization inside a Classic Simple XML dashboard, for example KO History → KO Version.');
                return;
            }

            // Resolve baseline + target source strings.
            var pick = this._pickVersions(data, c);
            if (!pick.targetXml) {
                this.iframe.style.visibility = 'hidden';
                this._showPlaceholder('Need a newer version',
                    'Could not resolve the newer dashboard source. Check the role field / selection.');
                return;
            }

            var targetHash = hashString(c.previewSlot + '|' + pick.targetXml);
            var baseHash = hashString(c.baselineSlot + '|' + (pick.baselineXml || ''));
            // What must be WRITTEN (needs approval): target always; baseline only for blend.
            var writeKey = targetHash + (c.showBlend ? ('+' + baseHash) : '');
            // What drives the DIFF (no approval needed): baseline + target content.
            // Hash separately to avoid a concat copy of potentially large strings (D8 fix).
            var diffKey = hashString(pick.baselineXml || '') + ':' + hashString(pick.targetXml);

            this._pending = { c: c, pick: pick, writeKey: writeKey, diffKey: diffKey,
                              targetHash: targetHash, baseHash: baseHash };

            if (writeKey === this._writtenKey) {
                // Already rendered this write set. Refresh diff if inputs changed.
                this._hideOverlay();
                this.iframe.style.visibility = 'visible';
                // D9 fix: also re-inject iframe highlight boxes when diff inputs changed
                // (without this, the boxes show the previous baseline's diff).
                if (diffKey !== this._lastDiffKey) { this._renderDiff(); this._scheduleHighlightInjection(); }
                return;
            }
            if (writeKey === this._inflightKey) return;
            if (this._rejectedKeys[writeKey]) { this._showRejected(); return; }
            if (this._approvedKeys[writeKey]) { this._performWrite(); return; }

            this.iframe.style.visibility = 'hidden';
            this._showApprovalPrompt();
        },

        _applyChrome: function(c) {
            if (c.bg !== this._lastBg) { this.el.style.background = c.bg; this._lastBg = c.bg; }
            if (c.scale !== this._lastScale) {
                if (c.scale === 1) {
                    this.frameWrap.style.transform = '';
                    this.frameWrap.style.width = '100%';
                    this.frameWrap.style.height = '100%';
                } else {
                    var inv = (100 / c.scale) + '%';
                    this.frameWrap.style.transform = 'scale(' + c.scale + ')';
                    this.frameWrap.style.width = inv;
                    this.frameWrap.style.height = inv;
                }
                this._lastScale = c.scale;
            }
        },

        _pickVersions: function(data, c) {
            var rows = data.rows, colIdx = data.colIdx;
            var dF = colIdx[c.dataField];
            var rF = colIdx[c.roleField];
            var baselineXml = '', targetXml = '', originApp = c.appDefault;
            var appF = colIdx[c.appField];

            if (rF !== undefined) {
                for (var i = 0; i < rows.length; i++) {
                    var role = String(rows[i][rF] == null ? '' : rows[i][rF]).trim().toLowerCase();
                    if (role === String(c.baselineValue).trim().toLowerCase() && !baselineXml) baselineXml = rows[i][dF];
                    if (role === String(c.targetValue).trim().toLowerCase() && !targetXml) {
                        targetXml = rows[i][dF];
                        if (appF !== undefined && rows[i][appF]) originApp = rows[i][appF];
                    }
                }
            }
            // Fallback: row 0 = target (newest), row 1 = baseline.
            if (!targetXml) {
                targetXml = rows[0][dF];
                if (appF !== undefined && rows[0][appF]) originApp = rows[0][appF];
            }
            if (!baselineXml && rows.length > 1) baselineXml = rows[1][dF];

            return { baselineXml: baselineXml, targetXml: targetXml, originApp: originApp };
        },

        // ── overlay states ──────────────────────────────────────

        _hideOverlay: function() { this._overlayKey = null; this.overlay.style.display = 'none'; clear(this.overlay); },

        _showPlaceholder: function(headline, detail) {
            this._overlayKey = null;
            clear(this.overlay);
            this.overlay.style.display = 'flex';
            this.overlay.appendChild(el('div', 'dashboard-preview-viz__placeholder-head', headline));
            this.overlay.appendChild(el('div', 'dashboard-preview-viz__placeholder-detail', detail));
        },

        _showApprovalPrompt: function() {
            var p = this._pending; if (!p) return;
            // Skip full overlay rebuild (incl. inspectSource regex) if we are
            // already showing the approval prompt for this exact writeKey (V4 fix).
            // Use a prefixed key so approval+rejected states for the same writeKey
            // still rebuild when transitioning (user clicks Reject).
            var overlayKey = 'approval:' + p.writeKey;
            if (this._overlayKey === overlayKey) return;
            this._overlayKey = overlayKey;
            clear(this.overlay);
            this.overlay.style.display = 'flex';

            var info = inspectSource(p.pick.targetXml);
            var binfo = p.pick.baselineXml ? inspectSource(p.pick.baselineXml) : null;
            var card = el('div', 'dashboard-preview-viz__card');
            card.appendChild(el('div', 'dashboard-preview-viz__card-eyebrow', 'Approval required'));
            card.appendChild(el('div', 'dashboard-preview-viz__card-head', 'Render & diff this dashboard?'));

            var sub = el('div', 'dashboard-preview-viz__card-sub');
            sub.appendChild(document.createTextNode('Writes newer version to '));
            sub.appendChild(el('code', null, PREVIEW_APP + '/' + p.c.previewSlot));
            if (p.c.showBlend) {
                sub.appendChild(document.createTextNode(' and older version to '));
                sub.appendChild(el('code', null, PREVIEW_APP + '/' + p.c.baselineSlot));
            }
            sub.appendChild(document.createTextNode('.'));
            card.appendChild(sub);

            var meta = el('dl', 'dashboard-preview-viz__meta');
            function row(k, v) { if (v || v === 0) { meta.appendChild(el('dt', null, k)); meta.appendChild(el('dd', null, v)); } }
            row('Newer', info.label || '(no label)');
            row('Type', info.kind);
            if (binfo) row('Older', binfo.label || '(no label)');
            row('Origin app', p.pick.originApp);
            row('Newer size', info.sizeKb + ' KB');
            card.appendChild(meta);

            var btnRow = el('div', 'dashboard-preview-viz__buttons');
            var rejectBtn = el('button', 'dashboard-preview-viz__btn', 'Reject');
            var approveBtn = el('button', 'dashboard-preview-viz__btn dashboard-preview-viz__btn--primary', 'Render & diff');
            btnRow.appendChild(rejectBtn);
            btnRow.appendChild(approveBtn);
            card.appendChild(btnRow);
            this.overlay.appendChild(card);

            var self = this, key = p.writeKey;
            approveBtn.addEventListener('click', function() { mapSet(self._approvedKeys, self._approvedOrder, key, 50); self._performWrite(); });
            rejectBtn.addEventListener('click', function() { mapSet(self._rejectedKeys, self._rejectedOrder, key, 50); self._showRejected(); });
        },

        _showRejected: function() {
            var p = this._pending; if (!p) return;
            // Skip rebuild if already showing the rejected state for this writeKey (V4 fix).
            var overlayKey = 'rejected:' + p.writeKey;
            if (this._overlayKey === overlayKey) return;
            this._overlayKey = overlayKey;
            clear(this.overlay);
            this.overlay.style.display = 'flex';
            var card = el('div', 'dashboard-preview-viz__card dashboard-preview-viz__card--muted');
            card.appendChild(el('div', 'dashboard-preview-viz__card-eyebrow', 'Render rejected'));
            card.appendChild(el('div', 'dashboard-preview-viz__card-head', 'Not rendered.'));
            card.appendChild(el('div', 'dashboard-preview-viz__card-sub',
                'You rejected this version. Approve to render anyway, or change your selection.'));
            var btnRow = el('div', 'dashboard-preview-viz__buttons');
            var approveBtn = el('button', 'dashboard-preview-viz__btn dashboard-preview-viz__btn--primary', 'Approve & render');
            btnRow.appendChild(approveBtn);
            card.appendChild(btnRow);
            this.overlay.appendChild(card);
            var self = this, key = p.writeKey;
            approveBtn.addEventListener('click', function() {
                delete self._rejectedKeys[key]; mapSet(self._approvedKeys, self._approvedOrder, key, 50); self._performWrite();
            });
        },

        _performWrite: function() {
            var p = this._pending; if (!p) return;
            var self = this, key = p.writeKey;
            this._inflightKey = key;
            this._showPlaceholder('Rendering preview', 'Writing source to ' + PREVIEW_APP + '/' + p.c.previewSlot + '…');
            this.iframe.style.visibility = 'hidden';

            var writes = [upsertView(p.c.previewSlot, p.pick.targetXml)];
            if (p.c.showBlend && p.pick.baselineXml) {
                writes.push(upsertView(p.c.baselineSlot, p.pick.baselineXml));
            }

            var _timeout = rejectAfter(20000);
            Promise.race([Promise.all(writes), _timeout.promise]).then(function() {
                _timeout.cancel();
                if (self._removed) return;  // D5: viz torn down while write was in-flight
                if (self._inflightKey !== key) return;
                var url = buildPreviewUrl(p.c.previewSlot, p.c.urlParams, p.targetHash);
                if (url !== self._lastUrl) { self.iframe.src = url; self._lastUrl = url; }

                if (p.c.showBlend && p.pick.baselineXml) {
                    var burl = buildPreviewUrl(p.c.baselineSlot, p.c.urlParams, p.baseHash);
                    if (burl !== self._lastBaseUrl) { self.baseIframe.src = burl; self._lastBaseUrl = burl; }
                    self.baseIframe.style.display = 'block';
                    self.iframe.classList.add('dashboard-preview-viz__frame--blend');
                } else {
                    self.baseIframe.style.display = 'none';
                    self.iframe.classList.remove('dashboard-preview-viz__frame--blend');
                }

                self._writtenKey = key;
                self._inflightKey = null;
                self.iframe.style.visibility = 'visible';
                self._hideOverlay();
                self._renderDiff();
                self._scheduleHighlightInjection();
            })['catch'](function(err) {
                _timeout.cancel();
                if (self._removed) return;  // D5: viz torn down while write was in-flight
                if (self._inflightKey !== key) return;
                self._inflightKey = null;
                var msg = (err && err.message) ? err.message : String(err);
                var csrf = getCsrfToken() ? 'present' : 'MISSING (no splunkweb_csrf_token cookie, viz may be sandboxed)';
                var detail = msg + '  ·  target app: ' + PREVIEW_APP + '  ·  CSRF token: ' + csrf;
                if (typeof console !== 'undefined' && console.error) {
                    console.error('[dashboard_preview] write failed:', detail, err);
                }
                self._showPlaceholder('Preview failed', detail);
            });
        },

        // ── diff rendering (drawer) ─────────────────────────────

        _renderDiff: function() {
            var p = this._pending; if (!p) return;
            var c = p.c;
            this._lastDiffKey = p.diffKey;

            var kind = detectKind(p.pick.targetXml);
            var changes;
            if (kind === 'studio') {
                changes = diffStudio(extractStudioDefinition(p.pick.baselineXml), extractStudioDefinition(p.pick.targetXml));
            } else {
                changes = diffSxml(p.pick.baselineXml, p.pick.targetXml);
            }
            this._lastChanges = changes;
            this._lastKind = kind;

            var showDrawer = c.showChangeList || c.showSourceDiff;
            this.drawer.style.display = showDrawer ? 'flex' : 'none';
            this.frameWrap.classList.toggle('dashboard-preview-viz__frame-wrap--with-drawer', showDrawer);
            if (!showDrawer) return;

            clear(this.drawer);

            // Summary header
            var counts = { added: 0, removed: 0, changed: 0, moved: 0 };
            for (var i = 0; i < changes.length; i++) counts[changes[i].kind]++;
            var header = el('div', 'dp-drawer__header');
            header.appendChild(el('div', 'dp-drawer__title', 'Diff vs older version'));
            var chips = el('div', 'dp-drawer__chips');
            function chip(kindKey, n) {
                if (!n) return;
                var sp = el('span', 'dp-chip ' + KIND_COLORS[kindKey].chip, KIND_COLORS[kindKey].label + ' ' + n);
                chips.appendChild(sp);
            }
            chip('added', counts.added); chip('changed', counts.changed);
            chip('moved', counts.moved); chip('removed', counts.removed);
            if (!changes.length) chips.appendChild(el('span', 'dp-chip dp-chip--none', 'NO CHANGES'));
            header.appendChild(chips);
            this.drawer.appendChild(header);

            var body = el('div', 'dp-drawer__body');
            this.drawer.appendChild(body);

            if (c.showChangeList) {
                var list = el('div', 'dp-changelist');
                if (!changes.length) {
                    list.appendChild(el('div', 'dp-changelist__empty', 'The two versions are structurally identical.'));
                }
                for (var j = 0; j < changes.length; j++) {
                    var ch = changes[j];
                    var item = el('div', 'dp-change dp-change--' + ch.kind);
                    var head = el('div', 'dp-change__head');
                    head.appendChild(el('span', 'dp-chip ' + KIND_COLORS[ch.kind].chip, KIND_COLORS[ch.kind].label));
                    head.appendChild(el('span', 'dp-change__label', ch.label));
                    item.appendChild(head);
                    for (var d = 0; d < ch.details.length; d++) {
                        item.appendChild(el('div', 'dp-change__detail', ch.details[d]));
                    }
                    list.appendChild(item);
                }
                body.appendChild(list);
            }

            if (c.showSourceDiff) {
                var dl = lineDiff(prettyForDiff(p.pick.baselineXml, kind), prettyForDiff(p.pick.targetXml, kind));
                var pre = el('div', 'dp-srcdiff');
                var addN = 0, delN = 0, cap = 4000;
                for (var k = 0; k < dl.length && k < cap; k++) {
                    var ln = dl[k];
                    var row2 = el('div', 'dp-srcdiff__line dp-srcdiff__line--' + ln.type);
                    var sign = ln.type === 'add' ? '+' : (ln.type === 'del' ? '-' : (ln.type === 'info' ? '!' : ' '));
                    row2.appendChild(el('span', 'dp-srcdiff__sign', sign));
                    row2.appendChild(el('span', 'dp-srcdiff__text', ln.text));
                    pre.appendChild(row2);
                    if (ln.type === 'add') addN++; if (ln.type === 'del') delN++;
                }
                if (dl.length > cap) pre.appendChild(el('div', 'dp-srcdiff__line dp-srcdiff__line--info',
                    '… diff truncated at ' + cap + ' lines'));
                var srcHead = el('div', 'dp-drawer__subhead');
                srcHead.appendChild(el('span', null, 'Source diff'));
                srcHead.appendChild(el('span', 'dp-srcdiff__stat', '+' + addN + ' −' + delN));
                body.appendChild(srcHead);
                body.appendChild(pre);
            }
        },

        // ── in-iframe highlight injection ───────────────────────

        // ── in-iframe highlight injection ───────────────────────────────────────
        // Backported from src/util/highlightInject.js (wrapper's improved version):
        //   - 4 extra panel selectors incl. [data-testid="visualization"],
        //     [data-input-id], [data-test-input-id], [data-component="DashboardElement"]
        //   - CSS.escape-protected id lookup
        //   - full attribute loop (any attr value matches id)
        //   - querySelector host-walk for id-hosted-inside-panel lookups
        //   - 1200-char outerHTML fallback (was 400)
        //   - dashed border-style for removed panels (was solid only)
        //   - maxTries 25 (was 20)

        _scheduleHighlightInjection: function() {
            if (this._hlTimer) { clearInterval(this._hlTimer); this._hlTimer = null; }
            var p = this._pending; if (!p) return;
            if (!p.c.showHighlights) { return; }
            var self = this;
            var tries = 0, maxTries = 25, lastCount = -1, stable = 0;
            // Wait for the iframe doc + panels to render, then inject.
            this._hlTimer = setInterval(function() {
                tries++;
                var ok = self._tryInjectHighlights();
                if (ok.done) {
                    if (ok.count === lastCount) stable++; else stable = 0;
                    lastCount = ok.count;
                    if (stable >= 2 || tries >= maxTries) {
                        clearInterval(self._hlTimer); self._hlTimer = null;
                    }
                } else if (tries >= maxTries) {
                    clearInterval(self._hlTimer); self._hlTimer = null;
                }
            }, 400);
        },

        // Returns {done:bool, count:int}. done=false means doc not ready yet.
        _tryInjectHighlights: function() {
            var p = this._pending;
            var changes = this._lastChanges;
            var kind = this._lastKind;
            if (!p || !changes) return { done: true, count: 0 };
            var doc;
            try {
                doc = this.iframe.contentDocument || (this.iframe.contentWindow && this.iframe.contentWindow.document);
            } catch (e) { return { done: true, count: 0 }; } // cross-origin -> give up quietly
            if (!doc || !doc.body) return { done: false, count: 0 };

            this._ensureHlStyle(doc);

            // Remove any previous highlights we added.
            var prev = doc.querySelectorAll('.dp-injected-hl');
            for (var r = 0; r < prev.length; r++) prev[r].parentNode && prev[r].parentNode.removeChild(prev[r]);

            var panels = this._findPanels(doc, p.c.hlSelector);
            if (!panels.length) return { done: false, count: 0 };

            var injected = 0;
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                if (ch.kind === 'removed') continue; // not present in target
                var node = this._matchPanel(panels, ch, kind, doc);
                if (!node) continue;
                this._decorate(doc, node, ch);
                injected++;
            }
            return { done: true, count: injected };
        },

        _ensureHlStyle: function(doc) {
            if (doc.getElementById('dp-hl-style')) return;
            var css = '' +
                '.dp-injected-hl{position:absolute;pointer-events:none;z-index:9998;border-radius:3px;box-sizing:border-box;}' +
                '.dp-injected-hl--box{inset:0;border-width:2px;}' +
                '.dp-injected-hl--badge{top:4px;left:4px;z-index:9999;font:700 9px/1.4 sans-serif;letter-spacing:.05em;' +
                'padding:2px 6px;border-radius:3px;color:#0b0c10;pointer-events:none;}';
            var st = doc.createElement('style');
            st.id = 'dp-hl-style';
            st.textContent = css;
            (doc.head || doc.body).appendChild(st);
        },

        _findPanels: function(doc, override) {
            var selectors = [];
            if (override) selectors.push(override);
            // Studio candidates (best-effort across builds) + Classic SXML.
            // Ordered by specificity — more specific/newer selectors first.
            selectors = selectors.concat([
                '[data-input-id][data-viz-type]',
                '[data-test="visualization"]',
                '[data-testid="visualization"]',
                '[data-input-id]',
                '[data-test-input-id]',
                '[data-viz-id]',
                '[data-element-id]',
                '[data-component="DashboardElement"]',
                '.dashboard-element',
                '.dashboard-panel'
            ]);
            for (var i = 0; i < selectors.length; i++) {
                var found;
                try { found = doc.querySelectorAll(selectors[i]); } catch (e) { found = null; }
                if (found && found.length) {
                    var arr = [];
                    for (var j = 0; j < found.length; j++) arr.push(found[j]);
                    return arr;
                }
            }
            return [];
        },

        _matchPanel: function(panels, ch, kind, doc) {
            if (kind === 'studio') {
                // Try id-based match: exact id attr, then any attribute value, then
                // querySelector host-walk, then outerHTML substring.
                var id = String(ch.id);
                var i, k;
                for (i = 0; i < panels.length; i++) {
                    var n = panels[i];
                    if (n.id === id) return n;
                    // Loop ALL attributes (covers data-input-id, data-viz-id, etc.)
                    if (n.attributes) {
                        for (k = 0; k < n.attributes.length; k++) {
                            if (n.attributes[k].value === id) return n;
                        }
                    }
                }
                // querySelector with CSS.escape guard, then walk up to a panel.
                var escapedId = id;
                try {
                    if (typeof window !== 'undefined' && window.CSS && window.CSS.escape) {
                        escapedId = window.CSS.escape(id);
                    }
                } catch (e) { /* ignore */ }
                var host = null;
                try {
                    host = doc.querySelector(
                        '[id="' + escapedId + '"],' +
                        '[data-input-id="' + escapedId + '"],' +
                        '[data-test-input-id="' + escapedId + '"],' +
                        '[data-viz-id="' + escapedId + '"]'
                    );
                } catch (e) { host = null; }
                if (host) {
                    for (i = 0; i < panels.length; i++) {
                        if (panels[i] === host || panels[i].contains(host) || host.contains(panels[i])) return panels[i];
                    }
                    return host;
                }
                // 1200-char outerHTML substring fallback.
                for (i = 0; i < panels.length; i++) {
                    var html = panels[i].outerHTML ? panels[i].outerHTML.slice(0, 1200) : '';
                    if (html.indexOf(id) !== -1) return panels[i];
                }
                return null;
            }
            // SXML: ch.id is a panel index → nth panel in document order.
            var idx = ch.id | 0;
            return panels[idx] || null;
        },

        _decorate: function(doc, node, ch) {
            // Ensure positioning context.
            var cs = (doc.defaultView || window).getComputedStyle(node);
            if (cs && cs.position === 'static') node.style.position = 'relative';
            var col = KIND_COLORS[ch.kind] || KIND_COLORS.changed;
            var box = doc.createElement('div');
            box.className = 'dp-injected-hl dp-injected-hl--box';
            box.style.borderColor = col.border;
            // Dormant branch: caller (_tryInjectHighlights) skips 'removed' at line 935; kept in
            // sync with util/highlightInject.js which uses 'dashed' for removed markers.
            box.style.borderStyle = ch.kind === 'removed' ? 'dashed' : 'solid';
            box.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.25), inset 0 0 18px ' + col.border + '33';
            node.appendChild(box);
            var badge = doc.createElement('div');
            badge.className = 'dp-injected-hl dp-injected-hl--badge';
            badge.style.background = col.border;
            badge.textContent = col.label + (ch.label ? ' · ' + String(ch.label).slice(0, 28) : '');
            node.appendChild(badge);
        },

        reflow: function() { /* iframes + injected highlights are CSS-anchored */ },

        remove: function() {
            // Signal any in-flight _performWrite callbacks to bail out immediately
            // rather than mutating the removed viz's DOM or re-arming the highlight
            // timer (D5 fix).
            this._removed = true;
            this._overlayKey = null;
            this._inflightKey = null;
            if (this._hlTimer) { clearInterval(this._hlTimer); this._hlTimer = null; }
            try { this.iframe.src = 'about:blank'; } catch (e) {}
            try { this.baseIframe.src = 'about:blank'; } catch (e2) {}
            this._lastChanges = null;
            this._pending = null;
            this._approvedKeys = null;  this._approvedOrder = null;
            this._rejectedKeys = null;  this._rejectedOrder = null;
            if (SplunkVisualizationBase.prototype.remove) {
                SplunkVisualizationBase.prototype.remove.apply(this, arguments);
            }
        }
    });
});
