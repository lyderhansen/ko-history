/*
 * ko_history.ko_viewer — saved-search (report / alert) and generic KO record viz.
 *
 * Renders ONE saved search version as a Splunk-native record card: header +
 * status/kind seals, then titled sections (Definition + SPL + Copy, Schedule
 * with humanized cron, Trigger Actions as one chip per ACTIVE action, and an
 * Alert Condition section shown only for real alerts).
 *
 * DOM viz (NOT Canvas) — like source_viewer — so SPL stays selectable/copyable
 * and the card reflows. Sandbox-safe: pure client-side, no fetch/iframe.
 * Theme via root class .korc--dark / .korc--light (Splunk Enterprise tokens
 * live in visualization.css). Data contract: one ROW_MAJOR result row whose
 * columns are the ko_reports_and_alerts_backup fields (dotted names intact).
 */
define([
    'api/SplunkVisualizationBase',
    'api/SplunkVisualizationUtils'
], function (SplunkVisualizationBase, SplunkVisualizationUtils) {

    // ── render-key hash (djb2 + FNV-1a, ES5) ─────────────────────────────────
    // Duplicated from source_viewer/visualization_source.js — shared-module
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

    // ── DOM helpers ──────────────────────────────────────────
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function truthy(v) { return v === '1' || v === 1 || v === 'true' || v === true; }

    // ── cron humanizer (best-effort; returns '' when unsure) ──
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    function humanizeCron(expr) {
        if (!expr) return '';
        var p = String(expr).trim().split(/\s+/);
        if (p.length !== 5) return '';
        var m = p[0], h = p[1], dom = p[2], mon = p[3], dow = p[4];
        var everyMin = /^\*\/(\d+)$/.exec(m);
        if (everyMin && h === '*' && dom === '*' && mon === '*' && dow === '*')
            return 'every ' + everyMin[1] + ' minute' + (everyMin[1] === '1' ? '' : 's');
        var everyHr = /^\*\/(\d+)$/.exec(h);
        if (/^\d+$/.test(m) && everyHr && dom === '*' && mon === '*' && dow === '*')
            return 'every ' + everyHr[1] + ' hour' + (everyHr[1] === '1' ? '' : 's') + ' at :' + pad2(m);
        if (m === '*' && h === '*') return 'every minute';
        if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
            var at = pad2(h) + ':' + pad2(m);
            if (dom === '*' && mon === '*' && dow === '*') return 'daily at ' + at;
            if (dom === '*' && mon === '*' && /^\d$/.test(dow)) return 'weekly on ' + DOW[+dow] + ' at ' + at;
            if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return 'monthly on day ' + dom + ' at ' + at;
            return 'at ' + at;
        }
        return '';
    }

    // alert.severity integer → label. Splunk's 6-level scale; adjust here if a
    // given build labels them differently.
    var SEV = { '1': 'Info', '2': 'Low', '3': 'Normal', '4': 'High', '5': 'Critical', '6': 'Fatal' };

    // Known trigger actions → how to render their chip. Each builds rows from f().
    function emailRows(f) {
        return prune([
            ['to', f('action.email.to')],
            ['cc', f('action.email.cc')],
            ['subject', f('action.email.subject')],
            ['from', f('action.email.from')],
            ['message', f('action.email.message.alert')]
        ]);
    }
    function scriptRows(f) { return prune([['filename', f('action.script.filename')]]); }
    function webhookRows(f) { return prune([['url', f('action.webhook.param.url')]]); }
    function summaryRows(f, cols) {
        var rows = prune([['index', f('action.summary_index._name')]]);
        // surface any extra user-defined summary_index.* fields (e.g. _cam)
        for (var i = 0; i < cols.length; i++) {
            var name = cols[i];
            if (name.indexOf('action.summary_index.') === 0 && name !== 'action.summary_index._name') {
                var v = f(name);
                if (v) rows.push([name.replace('action.summary_index.', ''), v]);
            }
        }
        return rows;
    }
    function prune(pairs) { var o = []; for (var i = 0; i < pairs.length; i++) if (pairs[i][1]) o.push(pairs[i]); return o; }

    // pretty label for the kind seal on the generic profile
    var TYPE_LABELS = {
        savedsearch: 'Saved Search', macro: 'Macro', eventtype: 'Event Type',
        fieldextraction: 'Field Extraction', extraction: 'Field Extraction',
        fieldtransform: 'Field Transform', transform: 'Field Transform',
        lookup: 'Lookup', tag: 'Tag', calcfield: 'Calculated Field',
        fieldalias: 'Field Alias', workflowaction: 'Workflow Action', view: 'Dashboard'
    };
    function prettyType(t) {
        if (!t) return 'Knowledge Object';
        if (TYPE_LABELS[t]) return TYPE_LABELS[t];
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    var ACTION_DEFS = {
        email: { label: 'Email', icon: 'M3 5h18v14H3z|M3 7l9 6 9-6', rows: emailRows },
        script: { label: 'Script', icon: 'M8 6l-5 6 5 6|M16 6l5 6-5 6', rows: scriptRows },
        webhook: { label: 'Webhook', icon: 'M6 18a4 4 0 1 0 0-8|M18 6a4 4 0 1 0 0 8|M9 12h6', rows: webhookRows },
        summary_index: { label: 'Summary Index', icon: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z|M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7', rows: summaryRows }
    };

    function iconSvg(paths, cls) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        if (cls) svg.setAttribute('class', cls);
        var segs = paths.split('|');
        for (var i = 0; i < segs.length; i++) {
            var node = document.createElementNS(ns, 'path');
            node.setAttribute('d', segs[i]);
            svg.appendChild(node);
        }
        return svg;
    }

    // Must live ABOVE the return: everything after it is unreachable.
    // A `var` down there hoists as undefined and never assigns.
    var _spl = require('../../../../../src/shared/splHighlight.js');
    var _dashMeta = require('../../../../../src/shared/dashboardMeta.js');
    var _lineDiffCore = require('../../../../../src/shared/lineDiff.js');

    return SplunkVisualizationBase.extend({

        initialize: function () {
            SplunkVisualizationBase.prototype.initialize.apply(this, arguments);
            this.el.classList.add('ko-viewer-viz');
            this.root = el('div', 'korc');
            this.el.appendChild(this.root);
            this._lastRenderKey = null;
        },

        getInitialDataParams: function () {
            return { outputMode: SplunkVisualizationBase.ROW_MAJOR_OUTPUT_MODE, count: 2 };
        },

        formatData: function (data) {
            if (!data || !data.rows || data.rows.length === 0) {
                return { empty: true, fields: [], rows: [] };
            }
            return { empty: false, fields: data.fields || [], rows: data.rows };
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
                titleField: g('titleField', 'title'),
                appField: g('appField', 'appName'),
                typeField: g('typeField', 'type'),
                showCopy: g('showCopy', 'true') === 'true',
                // Compare mode (Phase 3): auto = diff whenever a previous version
                // is present, else single. A role column tags the rows; the token
                // VALUES stay 'target'/'baseline' (internal plumbing shared with
                // the other vizs + the feed searches) but every USER-FACING label
                // reads LATEST / PREVIOUS.
                mode: g('mode', 'auto'),
                roleField: g('roleField', 'role'),
                latestValue: g('latestValue', 'target'),
                previousValue: g('previousValue', 'baseline'),
                theme: this._resolveTheme(g('themeMode', 'auto'))
            };

            if (data.empty || !data.rows.length) {
                // Reset the render key so identical content re-renders after a
                // transient empty tick (else the short-circuit would keep
                // showing this placeholder forever).
                this._lastRenderKey = null;
                this.root.className = 'korc korc--' + c.theme;
                this.root.innerHTML = '';
                this.root.appendChild(el('div', 'korc__empty',
                    'Awaiting data. Provide a knowledge-object result row (title + its config fields).'));
                return;
            }

            // column-name → index
            var cols = [], idx = {};
            for (var i = 0; i < data.fields.length; i++) { cols.push(data.fields[i].name); idx[data.fields[i].name] = i; }

            // Resolve LATEST (the version being viewed) and PREVIOUS (compared
            // against). Prefer an explicit role column; else row 0 = latest,
            // row 1 = previous.
            var rows = data.rows;
            var ri = (idx[c.roleField] !== undefined) ? idx[c.roleField] : -1;
            var latestRow = null, prevRow = null;
            if (ri >= 0) {
                for (var k = 0; k < rows.length; k++) {
                    var rv = String(rows[k][ri] == null ? '' : rows[k][ri]).trim().toLowerCase();
                    if (rv === String(c.latestValue).trim().toLowerCase() && !latestRow) latestRow = rows[k];
                    else if (rv === String(c.previousValue).trim().toLowerCase() && !prevRow) prevRow = rows[k];
                }
                if (!latestRow && rows.length) latestRow = rows[0];
                if (!prevRow && rows.length > 1) prevRow = rows[1];
            } else {
                latestRow = rows[0];
                if (rows.length > 1) prevRow = rows[1];
            }

            // ── render-key short-circuit: skip full innerHTML teardown + LCS diff
            // on every updateView tick when nothing has changed (D4 fix). ──
            // Key covers: full row payloads + theme + every option that affects rendering.
            // Hash per-cell and combine rather than join('\x00') to avoid allocating
            // a large intermediate string per tick (V5 fix; mirrors dashboard_preview D8).
            var _hRow = function (row) {
                if (!row) return '';
                var h = '';
                for (var _ri = 0; _ri < row.length; _ri++) {
                    h += hashString(row[_ri] == null ? '' : String(row[_ri])) + ',';
                }
                return h;
            };
            var renderKey = _hRow(latestRow) + ':' + _hRow(prevRow) + ':' +
                c.theme + ':' + (c.showCopy ? 1 : 0) + ':' + c.mode + ':' +
                c.titleField + ':' + c.appField + ':' + c.typeField + ':' +
                c.roleField + ':' + c.latestValue + ':' + c.previousValue;
            if (renderKey === this._lastRenderKey && this.root && this.root.firstChild) { return; }
            this._lastRenderKey = renderKey;

            this.root.className = 'korc korc--' + c.theme;
            this.root.innerHTML = '';

            var mk = function (rw) {
                return function (name) {
                    var kk = idx[name]; if (kk === undefined || !rw) return '';
                    var v = rw[kk]; return (v == null || v === 'n/a') ? '' : String(v);
                };
            };
            var fL = mk(latestRow), fP = mk(prevRow);

            var koType = (fL(c.typeField) || '').toLowerCase();
            var isSavedSearch = koType === 'savedsearch' || (fL('search') !== '' && fL('alert_type') !== '');
            // A dashboard's "definition" is a whole document, not a one-line
            // expression, so the generic card's code-field treatment reads badly
            // for it. Detected by the captured source rather than by ko_type
            // alone, so this still works when the type column is absent.
            var dashSrc = fL('data') || fL('eai:data') || '';
            // 'views' is the value this app actually stores: the capture searches
            // do `| rename eai:* as *`, so `type` carries eai:type verbatim, and
            // for dashboards that is the plural 'views'. Without it in this list
            // the card never fired on the app's own data and every dashboard fell
            // through to the generic code-field card. 'dashboard'/'view' stay for
            // hand-written searches that label the column themselves.
            var isDashboard = !isSavedSearch &&
                (koType === 'views' || koType === 'dashboard' || koType === 'view' ||
                 (koType === '' && /^[\s\uFEFF]*[<{]/.test(dashSrc)));
            var diffActive = !!prevRow && c.mode !== 'single';

            // Diff panel first (what changed previous → latest), then the full
            // LATEST card for context.
            if (diffActive) this.root.appendChild(this._diffPanel(fL, fP, cols, c));
            if (isSavedSearch) this.root.appendChild(this._savedSearchCard(fL, cols, c));
            else if (isDashboard) this.root.appendChild(this._dashboardCard(fL, cols, c, dashSrc));
            else this.root.appendChild(this._genericCard(fL, cols, c, koType));
        },

        // ── compare panel — LATEST vs PREVIOUS (type-agnostic) ──
        // A field-level change list + a line-by-line diff of the primary code
        // field. Sits above the full LATEST card. Works for ANY KO type because
        // it diffs the captured columns directly.
        _diffPanel: function (fL, fP, cols, c) {
            var sec = el('div', 'korc__sec korc__diff');
            var h = el('div', 'korc__sechead');
            h.appendChild(el('span', 'korc__secidx', 'Δ'));
            h.appendChild(el('span', 'korc__secname', 'Changes · older → newer'));
            h.appendChild(el('span', 'korc__secrule'));
            sec.appendChild(h);

            // pick the primary code field present in either version
            var CODE = [['definition', 'Definition'], ['search', 'Search'], ['regex', 'Regex'],
                        ['value', 'Value'], ['eval', 'Eval expression'], ['template', 'Template']];
            var codeField = '', codeLabel = '';
            for (var j = 0; j < CODE.length; j++) { if (fP(CODE[j][0]) || fL(CODE[j][0])) { codeField = CODE[j][0]; codeLabel = CODE[j][1]; break; } }

            // field-level changes (skip internal / role / the code field below)
            var SKIP = {}; SKIP[c.roleField] = 1; SKIP.role = 1; SKIP.data = 1;
            if (codeField) SKIP[codeField] = 1;
            var changes = [];
            for (var k = 0; k < cols.length; k++) {
                var name = cols[k];
                if (SKIP[name] || name.charAt(0) === '_') continue;
                var pv = fP(name), lv = fL(name);
                if (pv === lv || (!pv && !lv)) continue;
                changes.push({ name: name, status: !pv ? 'add' : (!lv ? 'del' : 'chg'), prev: pv, latest: lv });
            }
            var nChg = 0, nAdd = 0, nDel = 0;
            for (k = 0; k < changes.length; k++) { var st = changes[k].status; if (st === 'add') nAdd++; else if (st === 'del') nDel++; else nChg++; }
            var codeChanged = codeField && fP(codeField) !== fL(codeField);

            // meta line: previous → latest + counts
            var meta = el('div', 'korc__diffmeta');
            var pseal = el('span', 'korc__dseal prev'); pseal.appendChild(document.createTextNode('OLDER' + (fP('updated') ? ' · ' + fP('updated') : '')));
            var lseal = el('span', 'korc__dseal latest'); lseal.appendChild(document.createTextNode('NEWER' + (fL('updated') ? ' · ' + fL('updated') : '')));
            meta.appendChild(pseal);
            meta.appendChild(el('span', 'korc__darrow', '→'));
            meta.appendChild(lseal);
            var counts = el('span', 'korc__dcounts');
            if (nChg) counts.appendChild(this._cpill(nChg + ' changed', 'chg'));
            if (nAdd) counts.appendChild(this._cpill(nAdd + ' added', 'add'));
            if (nDel) counts.appendChild(this._cpill(nDel + ' removed', 'del'));
            if (codeChanged && !changes.length) counts.appendChild(this._cpill(codeLabel.toLowerCase() + ' edited', 'chg'));
            if (!nChg && !nAdd && !nDel && !codeChanged) counts.appendChild(el('span', 'korc__mut', 'no field changes'));
            meta.appendChild(counts);
            sec.appendChild(meta);

            if (codeChanged) sec.appendChild(this._codeDiff(codeLabel, fP(codeField), fL(codeField), c.showCopy));
            if (changes.length) sec.appendChild(this._diffRows(changes));
            if (!changes.length && !codeChanged) sec.appendChild(el('div', 'korc__none', 'These two versions are identical in their captured fields.'));
            return sec;
        },

        _cpill: function (text, kind) { return el('span', 'korc__cpill ' + kind, text); },

        _diffRows: function (changes) {
            var r = el('div', 'korc__rows korc__drows');
            for (var i = 0; i < changes.length; i++) {
                var ch = changes[i];
                r.appendChild(el('div', 'korc__k', ch.name));
                var v = el('div', 'korc__v korc__dv ' + ch.status);
                if (ch.status === 'add') {
                    v.appendChild(el('span', 'korc__dmut', '–'));
                    v.appendChild(el('span', 'korc__darrow2', ' → '));
                    v.appendChild(el('span', 'korc__dnow', ch.latest));
                } else if (ch.status === 'del') {
                    v.appendChild(el('span', 'korc__dwas', ch.prev));
                    v.appendChild(el('span', 'korc__darrow2', ' → '));
                    v.appendChild(el('span', 'korc__dmut', 'removed'));
                } else {
                    v.appendChild(el('span', 'korc__dwas', ch.prev));
                    v.appendChild(el('span', 'korc__darrow2', ' → '));
                    v.appendChild(el('span', 'korc__dnow', ch.latest));
                }
                r.appendChild(v);
            }
            return r;
        },

        _codeDiff: function (label, prev, latest, showCopy) {
            var wrap = el('div', 'korc__spl korc__cdiff');
            var bar = el('div', 'korc__splbar');
            bar.appendChild(el('span', 'korc__spllbl', label + ' · diff'));
            if (showCopy && latest) {
                var btn = el('button', 'korc__copy'); btn.type = 'button';
                btn.appendChild(iconSvg('M9 9h11v11H9z|M5 15V5a2 2 0 0 1 2-2h8', 'korc__copyic'));
                var lbl = el('span', 'korc__copylbl', 'Copy newer');
                btn.appendChild(lbl);
                btn.onclick = function () { copyText(latest, btn, lbl); };
                bar.appendChild(btn);
            }
            wrap.appendChild(bar);
            var code = el('div', 'korc__code korc__cdcode');
            var ops = diffOps(
                String(prev || '').replace(/\r/g, '').split('\n'),
                String(latest || '').replace(/\r/g, '').split('\n')
            );
            for (var i = 0; i < ops.length; i++) {
                var t = ops[i][0], text = ops[i][1];
                var ln = el('div', 'korc__ln korc__dl-' + t);
                ln.appendChild(el('span', 'korc__dgut', t === 'add' ? '+' : (t === 'del' ? '−' : ' ')));
                var co = document.createElement('code');
                co.innerHTML = highlightSpl(text);
                ln.appendChild(co);
                code.appendChild(ln);
            }
            wrap.appendChild(code);
            return wrap;
        },

        // ── saved-search profile ──────────────────────────────
        _savedSearchCard: function (f, cols, c) {
            var card = el('div', 'korc__card');

            // fallbacks: backup stores `appName`; ad-hoc may use `app`
            var app = f(c.appField) || f('app');
            var title = f(c.titleField) || '(untitled)';
            var alertType = f('alert_type');
            var isAlert = alertType && alertType !== 'always';
            var scheduled = truthy(f('is_scheduled'));
            var disabled = truthy(f('disabled'));
            var kind = isAlert ? 'Alert' : (scheduled ? 'Scheduled Report' : 'Saved Search');

            // ── header ──
            var head = el('div', 'korc__head');
            var hid = el('div', 'korc__hid');
            hid.appendChild(el('div', 'korc__title', title));
            var sub = el('div', 'korc__sub');
            sub.appendChild(this._kv('app', app || '–'));
            if (f('owner')) sub.appendChild(this._sep()), sub.appendChild(this._kv('owner', f('owner')));
            if (f('sharing')) sub.appendChild(this._sep()), sub.appendChild(this._kv('sharing', f('sharing')));
            if (f('updated')) sub.appendChild(this._sep()), sub.appendChild(this._kv('updated', f('updated')));
            hid.appendChild(sub);
            head.appendChild(hid);

            var seals = el('div', 'korc__seals');
            var st = el('span', 'korc__seal ' + (disabled ? 'off' : 'on'));
            st.appendChild(el('span', 'dot')); st.appendChild(document.createTextNode(disabled ? 'Disabled' : 'Enabled'));
            seals.appendChild(st);
            seals.appendChild(el('span', 'korc__seal kind', kind));
            head.appendChild(seals);
            card.appendChild(head);

            // ── 01 Definition ──
            var def = this._section('01', 'Definition');
            if (f('description')) def.appendChild(el('p', 'korc__desc', f('description')));
            def.appendChild(this._spl(f('search'), c.showCopy));
            var tr = [];
            if (f('dispatch.earliest_time') || f('dispatch.latest_time'))
                tr.push(['Time range', this._range(f('dispatch.earliest_time'), f('dispatch.latest_time'))]);
            if (tr.length) def.appendChild(this._rows(tr));
            card.appendChild(def);

            // ── 02 Schedule ──
            var sch = this._section('02', 'Schedule');
            var srows = [];
            srows.push(['Scheduled', scheduled ? this._miniSeal('Yes', 'on') : this._mut('No')]);
            if (scheduled && f('cron_schedule')) {
                var cron = f('cron_schedule'), hum = humanizeCron(cron);
                var cv = el('span'); cv.appendChild(this._code(cron));
                if (hum) { cv.appendChild(document.createTextNode('  ')); var hs = el('span', 'korc__hum', hum); cv.appendChild(hs); }
                srows.push(['Cron', cv]);
            }
            if (f('next_scheduled_time')) srows.push(['Next run', document.createTextNode(f('next_scheduled_time'))]);
            var win = f('schedule_window'), pri = f('schedule_priority');
            if (win || pri) srows.push(['Window / priority', this._mut((win || 'none') + ' · ' + (pri || 'default'))]);
            sch.appendChild(this._rows(srows));
            card.appendChild(sch);

            // ── 03 Trigger Actions ──
            var act = this._section('03', 'Trigger Actions');
            var names = (f('actions') || '').split(',');
            var chips = el('div', 'korc__chips'), any = false;
            for (var i = 0; i < names.length; i++) {
                var nm = names[i].replace(/^\s+|\s+$/g, '');
                if (!nm) continue;
                any = true;
                chips.appendChild(this._chip(nm, f, cols));
            }
            if (any) act.appendChild(chips);
            else act.appendChild(el('div', 'korc__none', 'No trigger actions configured.'));
            card.appendChild(act);

            // ── 04 Alert Condition (alerts only) ──
            if (isAlert) {
                var al = this._section('04', 'Alert Condition');
                var arows = [];
                var cmp = f('alert_comparator'), thr = f('alert_threshold');
                var trig = el('span');
                trig.appendChild(document.createTextNode('when '));
                trig.appendChild(this._code(alertType));
                if (cmp) { trig.appendChild(document.createTextNode(' is ')); trig.appendChild(this._code(cmp)); }
                if (thr !== '') { trig.appendChild(document.createTextNode(' ')); trig.appendChild(this._code(thr)); }
                arows.push(['Trigger', trig]);
                var sev = f('alert.severity');
                if (sev) {
                    var pill = el('span', 'korc__sev', sev + (SEV[sev] ? ' · ' + SEV[sev] : ''));
                    arows.push(['Severity', pill]);
                }
                var sup = f('alert.suppress'), supPer = f('alert.suppress.period'), supFld = f('alert.suppress.fields');
                if (truthy(sup) || supPer) {
                    var th = el('span'); th.appendChild(document.createTextNode('suppress '));
                    if (supPer) th.appendChild(this._code(supPer));
                    if (supFld) { th.appendChild(document.createTextNode(' by ')); th.appendChild(this._code(supFld)); }
                    arows.push(['Throttle', th]);
                }
                if (f('alert.expires')) arows.push(['Expires', document.createTextNode(f('alert.expires'))]);
                arows.push(['Tracking', truthy(f('alert.track')) ? document.createTextNode('on') : this._mut('off')]);
                al.appendChild(this._rows(arows));
                card.appendChild(al);
            }

            return card;
        },

        // ── dashboard profile ─────────────────────────────────
        // What the source cannot tell you at a glance: which flavour of
        // dashboard this is, what it is called, and how much is in it. The
        // source itself follows, because standalone (outside ko_version_ds,
        // where source_viewer sits alongside) this card is the only thing
        // rendering it.
        _dashboardCard: function (f, cols, c, src) {
            var card = el('div', 'korc__card');
            var m = _dashMeta(src);
            // The captured title column wins over the one inside the source:
            // the source's own label can lag a rename.
            var title = f(c.titleField) || m.label || '(untitled)';
            var app = f(c.appField) || f('app');
            var disabled = f('disabled');

            var head = el('div', 'korc__head');
            var hid = el('div', 'korc__hid');
            hid.appendChild(el('div', 'korc__title', title));
            var sub = el('div', 'korc__sub'), first = true;
            var subFields = [['app', app], ['owner', f('owner')], ['sharing', f('sharing')], ['updated', f('updated')]];
            for (var i = 0; i < subFields.length; i++) {
                if (!subFields[i][1]) continue;
                if (!first) sub.appendChild(this._sep());
                sub.appendChild(this._kv(subFields[i][0], subFields[i][1]));
                first = false;
            }
            hid.appendChild(sub);
            head.appendChild(hid);

            var seals = el('div', 'korc__seals');
            if (disabled !== '') {
                var off = truthy(disabled);
                var st = el('span', 'korc__seal ' + (off ? 'off' : 'on'));
                st.textContent = off ? 'disabled' : 'enabled';
                seals.appendChild(st);
            }
            if (m.panels !== null) {
                seals.appendChild(el('span', 'korc__seal',
                    m.panels + (m.panels === 1 ? ' panel' : ' panels')));
            }
            seals.appendChild(el('span', 'korc__seal kind', m.format));
            head.appendChild(seals);
            card.appendChild(head);

            var shown = {};
            shown[c.titleField] = 1; shown[c.appField] = 1; shown.app = 1; shown.owner = 1;
            shown.sharing = 1; shown.updated = 1; shown[c.typeField] = 1; shown.disabled = 1;
            var nextIdx = 1, pad = function (n) { return n < 10 ? '0' + n : '' + n; };

            var desc = f('description') || m.description;
            if (desc) {
                var d0 = this._section(pad(nextIdx++), 'Description');
                d0.appendChild(el('p', 'korc__desc', desc));
                card.appendChild(d0);
                shown.description = 1;
            }

            // Counts are null when the source could not be read. Printing 0
            // there would state something false, so the row is omitted and the
            // reason is shown instead.
            var st2 = [['format', m.format]];
            if (m.version) st2.push(['version', m.version]);
            if (m.theme) st2.push(['theme', m.theme]);
            if (m.panels !== null) st2.push(['panels', String(m.panels)]);
            if (m.searches !== null) st2.push([m.isStudio ? 'data sources' : 'searches', String(m.searches)]);
            if (m.inputs !== null) st2.push(['inputs', String(m.inputs)]);
            if (m.parseError) st2.push(['note', 'the definition could not be parsed, so panel counts are unavailable']);
            var stSec = this._section(pad(nextIdx++), 'Structure');
            stSec.appendChild(this._rows(st2));
            card.appendChild(stSec);

            if (src) {
                var sec = this._section(pad(nextIdx++), m.isStudio ? 'Definition · JSON' : 'Definition · Simple XML');
                sec.appendChild(this._spl(src, c.showCopy, m.isStudio ? 'Studio JSON' : 'Simple XML'));
                card.appendChild(sec);
                shown.data = 1; shown['eai:data'] = 1;
            }

            var rows = [];
            for (var k = 0; k < cols.length; k++) {
                var name = cols[k];
                if (shown[name] || name.charAt(0) === '_') continue;
                var val = f(name);
                if (!val) continue;
                rows.push([name, val]);
            }
            if (rows.length) {
                var det = this._section(pad(nextIdx++), 'Details');
                det.appendChild(this._rows(rows));
                card.appendChild(det);
            }
            return card;
        },

        // ── generic profile — any KO type (macro / eventtype / extraction / …)
        // Header + its primary definition/code field + an all-fields Details
        // section. Lights up new KO types immediately; a bespoke profile can be
        // added later by dispatching on ko_type in updateView.
        _genericCard: function (f, cols, c, koType) {
            var card = el('div', 'korc__card');
            var title = f(c.titleField) || '(untitled)';
            var app = f(c.appField) || f('app');
            var disabled = f('disabled');

            // header
            var head = el('div', 'korc__head');
            var hid = el('div', 'korc__hid');
            hid.appendChild(el('div', 'korc__title', title));
            var sub = el('div', 'korc__sub'), first = true;
            var subFields = [['app', app], ['owner', f('owner')], ['sharing', f('sharing')], ['updated', f('updated')]];
            for (var i = 0; i < subFields.length; i++) {
                if (!subFields[i][1]) continue;
                if (!first) sub.appendChild(this._sep());
                sub.appendChild(this._kv(subFields[i][0], subFields[i][1]));
                first = false;
            }
            hid.appendChild(sub);
            head.appendChild(hid);

            var seals = el('div', 'korc__seals');
            if (disabled !== '') {
                var off = truthy(disabled);
                var st = el('span', 'korc__seal ' + (off ? 'off' : 'on'));
                st.appendChild(el('span', 'dot')); st.appendChild(document.createTextNode(off ? 'Disabled' : 'Enabled'));
                seals.appendChild(st);
            }
            seals.appendChild(el('span', 'korc__seal kind', prettyType(koType)));
            head.appendChild(seals);
            card.appendChild(head);

            // 01 — primary definition / code field
            var CODE = [['definition', 'Definition'], ['search', 'Search'], ['regex', 'Regex'],
                        ['value', 'Value'], ['eval', 'Eval expression'], ['template', 'Template']];
            var codeField = '', codeVal = '', codeLabel = '';
            for (var j = 0; j < CODE.length; j++) { if (f(CODE[j][0])) { codeField = CODE[j][0]; codeVal = f(CODE[j][0]); codeLabel = CODE[j][1]; break; } }

            var shown = {};
            shown[c.titleField] = 1; shown[c.appField] = 1; shown.app = 1; shown.owner = 1;
            shown.sharing = 1; shown.updated = 1; shown[c.typeField] = 1; shown.disabled = 1;

            var nextIdx = 1, pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            if (codeField) {
                var def = this._section(pad(nextIdx++), codeLabel);
                if (f('description')) { def.appendChild(el('p', 'korc__desc', f('description'))); shown.description = 1; }
                def.appendChild(this._spl(codeVal, c.showCopy, codeField));
                card.appendChild(def);
                shown[codeField] = 1;
            } else if (f('description')) {
                var d0 = this._section(pad(nextIdx++), 'Description');
                d0.appendChild(el('p', 'korc__desc', f('description')));
                card.appendChild(d0); shown.description = 1;
            }

            // 02 — every remaining non-empty captured field
            var rows = [];
            for (var k = 0; k < cols.length; k++) {
                var name = cols[k];
                if (shown[name] || name.charAt(0) === '_') continue;
                var val = f(name);
                if (!val) continue;
                rows.push([name, val]);
            }
            if (rows.length) {
                var det = this._section(pad(nextIdx++), 'Details');
                det.appendChild(this._rows(rows));
                card.appendChild(det);
            }
            return card;
        },

        // ── section/row/atom builders ─────────────────────────
        _section: function (idx, name) {
            var s = el('div', 'korc__sec');
            var h = el('div', 'korc__sechead');
            h.appendChild(el('span', 'korc__secidx', idx));
            h.appendChild(el('span', 'korc__secname', name));
            h.appendChild(el('span', 'korc__secrule'));
            s.appendChild(h);
            return s;
        },
        _rows: function (pairs) {
            var r = el('div', 'korc__rows');
            for (var i = 0; i < pairs.length; i++) {
                r.appendChild(el('div', 'korc__k', pairs[i][0]));
                var v = el('div', 'korc__v');
                var val = pairs[i][1];
                if (typeof val === 'string') v.textContent = val; else v.appendChild(val);
                r.appendChild(v);
            }
            return r;
        },
        _kv: function (k, val) { var s = el('span'); s.appendChild(document.createTextNode(k + ': ')); s.appendChild(el('b', null, val)); return s; },
        _sep: function () { return el('span', 'korc__dot', '·'); },
        _code: function (t) { return el('code', null, t); },
        _mut: function (t) { return el('span', 'korc__mut', t); },
        _miniSeal: function (t, cls) { var s = el('span', 'korc__seal ' + cls + ' mini'); s.appendChild(el('span', 'dot')); s.appendChild(document.createTextNode(t)); return s; },
        _range: function (e, l) {
            var s = el('span');
            s.appendChild(document.createTextNode('earliest ')); s.appendChild(this._code(e || '–'));
            s.appendChild(document.createTextNode('  →  latest ')); s.appendChild(this._code(l || 'now'));
            return s;
        },

        _spl: function (spl, showCopy, label) {
            var wrap = el('div', 'korc__spl');
            var bar = el('div', 'korc__splbar');
            bar.appendChild(el('span', 'korc__spllbl', label || 'Search · SPL'));
            if (showCopy && spl) {
                var btn = el('button', 'korc__copy'); btn.type = 'button';
                btn.appendChild(iconSvg('M9 9h11v11H9z|M5 15V5a2 2 0 0 1 2-2h8', 'korc__copyic'));
                var lbl = el('span', 'korc__copylbl', 'Copy SPL');
                btn.appendChild(lbl);
                btn.onclick = function () { copyText(spl, btn, lbl); };
                bar.appendChild(btn);
            }
            wrap.appendChild(bar);
            var code = el('div', 'korc__code');
            var lines = String(spl || '').replace(/\r/g, '').split('\n');
            if (lines.length === 1 && lines[0] === '') lines = ['(no search string captured)'];
            for (var i = 0; i < lines.length; i++) {
                var ln = el('div', 'korc__ln');
                var co = document.createElement('code');
                co.innerHTML = highlightSpl(lines[i]);
                ln.appendChild(co);
                code.appendChild(ln);
            }
            wrap.appendChild(code);
            return wrap;
        },

        _chip: function (name, f, cols) {
            var def = ACTION_DEFS[name];
            var chip = el('div', 'korc__chip' + (name === 'summary_index' ? ' summary' : ''));
            var h = el('div', 'korc__chiph');
            if (def) h.appendChild(iconSvg(def.icon, 'korc__chipic'));
            h.appendChild(el('span', 'korc__chipnm', def ? def.label : name));
            chip.appendChild(h);
            var rows = def ? def.rows(f, cols) : [];
            if (rows.length) {
                var rr = el('div', 'korc__chiprows');
                for (var i = 0; i < rows.length; i++) {
                    rr.appendChild(el('span', 'korc__ck', rows[i][0]));
                    rr.appendChild(el('span', 'korc__cv', rows[i][1]));
                }
                chip.appendChild(rr);
            } else {
                chip.appendChild(el('div', 'korc__cnone', 'enabled'));
            }
            return chip;
        }
    });

    // ── LCS line diff (previous a → latest b) → ordered op list of
    // ['eq'|'del'|'add', text]. Shared engine (prefix/suffix trim, Int32Array,
    // graceful block-replace). See ko_history/src/shared/lineDiff.js.

    function diffOps(a, b) {
        var result = _lineDiffCore(a, b);
        var ops = [];
        for (var i = 0; i < result.ops.length; i++) {
            var op = result.ops[i];
            if (op.t === 'eq')  ops.push(['eq',  op.a]);
            else if (op.t === 'del') ops.push(['del', op.a]);
            else                ops.push(['add', op.b]);
        }
        return ops;
    }

    // ── SPL highlight — SINGLE PASS so we never re-match inserted markup.
    // One combined regex tokenizes strings | pipe-commands | keywords | numbers;
    // everything (matches and the gaps between) is esc()'d exactly once.
    // Matches Splunk's search-bar scheme: strings (red) | pipe-commands (teal) |
    // functions = identifier before '(' (purple) | operator keywords AS/BY/OR/
    // AND/NOT/IN/OUTPUT (orange) | numbers. Single pass — never re-matches markup.
    // SPL tokenizing lives in ko_history/src/shared/splHighlight.js so this viz
    // and the React wrapper cannot drift on what counts as a command or a
    // string. Here the tokens become spans with CSS classes (.t-cmd, .t-fn,
    // ...) styled by visualization.css; the wrapper renders the same tokens
    // with inline palette colors instead.
    function highlightSpl(line) {
        var toks = _spl.tokenizeSpl(line);
        var out = '';
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i];
            if (t.kind === 'text') out += esc(t.text);
            else out += '<span class="t-' + t.kind + '">' + esc(t.text) + '</span>';
        }
        return out;
    }

    // ── clipboard with execCommand fallback ──
    function copyText(text, btn, lbl) {
        var done = function () { flash(btn, lbl); };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { legacy(text, done); });
                return;
            }
        } catch (e) {}
        legacy(text, done);
    }
    function legacy(text, done) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta); done();
        } catch (e) {}
    }
    function flash(btn, lbl) {
        if (!btn || !lbl) return;
        var prev = lbl.textContent; btn.classList.add('is-copied'); lbl.textContent = 'Copied ✓';
        setTimeout(function () { btn.classList.remove('is-copied'); lbl.textContent = prev; }, 1400);
    }
});
