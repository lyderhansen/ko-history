/*
 * heaviness — client-side estimate of how expensive a stored KO dashboard is to
 * RUN, parsed straight from its source (no search executed). Used to warn before
 * the wrapper triggers live preview/compare searches.
 *
 * analyze(raw) -> {
 *   format, panels, searches, dataSources,
 *   range: { kind, label, secs },   // worst-case time range found
 *   flags: [short strings],         // human reasons it's heavy
 *   level: 'light'|'moderate'|'heavy',
 *   note,                           // caveat (e.g. ranges are token-driven)
 * }
 *
 * Heuristic, not exact — panels/searches can be token-gated, ranges can be set
 * by inputs at runtime (we flag that as a caveat rather than guess). Mirrors the
 * detection in jsonView.js; keep format detection roughly in sync.
 */

const DAY = 86400;
const UNIT_SECS = { s: 1, m: 60, h: 3600, d: DAY, w: 7 * DAY, mon: 30 * DAY, q: 90 * DAY, y: 365 * DAY };

function relSecs(tok) {
    const m = String(tok).match(/^[+-]?(\d+)\s*(mon|s|m|h|d|w|q|y)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    const mult = UNIT_SECS[u];
    return mult ? n * mult : null;
}

function humanSpan(secs) {
    if (secs >= 365 * DAY) return Math.round(secs / (365 * DAY)) + 'y';
    if (secs >= 30 * DAY) return Math.round(secs / (30 * DAY)) + 'mo';
    if (secs >= DAY) return Math.round(secs / DAY) + 'd';
    if (secs >= 3600) return Math.round(secs / 3600) + 'h';
    return Math.round(secs / 60) + 'm';
}

// Classify one earliest/latest pair into a comparable "weight".
// kind: 'realtime' | 'alltime' | 'span' | 'token' | 'unknown'
function classifyRange(earliest, latest) {
    const e = (earliest == null ? '' : String(earliest)).trim();
    const l = (latest == null ? '' : String(latest)).trim();
    if (/\$[^$]+\$/.test(e) || /\$[^$]+\$/.test(l)) return { kind: 'token' };
    if (/^rt/i.test(e) || /^rt/i.test(l)) return { kind: 'realtime' };
    if (e === '0') return { kind: 'alltime' };
    if (e === '') return { kind: 'unknown' };
    const secs = relSecs(e);
    if (secs == null) return { kind: 'unknown' };
    return { kind: 'span', secs };
}

// Pick the heaviest of a set of ranges. Order: realtime > alltime > largest span.
function worstRange(ranges) {
    let best = { kind: 'unknown', secs: 0 };
    let sawToken = false;
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (r.kind === 'token') { sawToken = true; continue; }
        if (r.kind === 'realtime') return { range: { kind: 'realtime', label: 'Real-time', secs: Infinity }, sawToken };
        if (r.kind === 'alltime') { best = { kind: 'alltime', secs: Infinity }; continue; }
        if (r.kind === 'span' && best.kind !== 'alltime' && r.secs > (best.secs || 0)) best = { kind: 'span', secs: r.secs };
    }
    let label;
    if (best.kind === 'alltime') label = 'All-time';
    else if (best.kind === 'span') label = 'last ' + humanSpan(best.secs);
    else label = sawToken ? 'set by inputs' : 'unknown';
    return { range: { kind: best.kind, label, secs: best.secs || 0 }, sawToken };
}

function detectFormat(raw) {
    const s = String(raw == null ? '' : raw);
    const t = s.replace(/^[﻿\s]+/, '');
    if (/<definition\b/i.test(s)) return 'Dashboard Studio';
    if (t.charAt(0) === '<') {
        return (/<dashboard[^>]*\bversion\s*=\s*["']2["']/i.test(s) || /<form[^>]*\bversion\s*=\s*["']2["']/i.test(s))
            ? 'Dashboard Studio' : 'Simple XML';
    }
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return 'JSON';
    return 'Raw';
}

function dsJsonText(raw) {
    const s = String(raw == null ? '' : raw);
    const defm = s.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
    if (defm) {
        const inner = defm[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/^\s+/, '');
        if (inner.charAt(0) === '{' || inner.charAt(0) === '[') return inner;
    }
    const t = s.replace(/^[﻿\s]+/, '');
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return t;
    return null;
}

function analyzeStudio(jsonText) {
    let def;
    try { def = JSON.parse(jsonText); } catch (e) { return null; }
    const viz = def.visualizations || {};
    const ds = def.dataSources || {};
    const inputs = def.inputs || {};
    const vizKeys = Object.keys(viz);
    const dsKeys = Object.keys(ds);
    let searches = 0;
    const ranges = [];
    dsKeys.forEach((k) => {
        const d = ds[k] || {};
        if (d.type === 'ds.search' || d.type === 'ds.chain') {
            if ((d.options || {}).query) searches++;
            const qp = (d.options || {}).queryParameters || {};
            if (qp.earliest !== undefined || qp.latest !== undefined) ranges.push(classifyRange(qp.earliest, qp.latest));
        }
    });
    Object.keys(inputs).forEach((k) => {
        const inp = inputs[k] || {};
        if (inp.type === 'input.timerange') {
            const dv = (inp.options || {}).defaultValue;
            if (typeof dv === 'string' && dv.indexOf(',') >= 0) {
                const parts = dv.split(',');
                ranges.push(classifyRange(parts[0], parts[1]));
            }
        }
    });
    return { format: 'Dashboard Studio', panels: vizKeys.length, searches, dataSources: dsKeys.length, ranges };
}

function analyzeSxml(xml) {
    const s = String(xml);
    const panels = (s.match(/<panel\b/gi) || []).length;
    const searches = (s.match(/<search\b/gi) || []).length;
    const ranges = [];
    // Pull <earliest>…</earliest> / <latest>…</latest> pairs (order-independent: we
    // just collect each as its own range with the matching latest if present).
    const earliests = [];
    const latests = [];
    let m;
    const eRe = /<earliest(?:\s[^>]*)?>([\s\S]*?)<\/earliest>/gi;
    const lRe = /<latest(?:\s[^>]*)?>([\s\S]*?)<\/latest>/gi;
    while ((m = eRe.exec(s)) !== null) earliests.push(m[1].trim());
    while ((m = lRe.exec(s)) !== null) latests.push(m[1].trim());
    const n = Math.max(earliests.length, latests.length);
    for (let i = 0; i < n; i++) ranges.push(classifyRange(earliests[i], latests[i]));
    return { format: 'Simple XML', panels, searches, dataSources: searches, ranges };
}

export function analyze(raw) {
    const empty = { format: 'Raw', panels: 0, searches: 0, dataSources: 0, range: { kind: 'unknown', label: 'unknown', secs: 0 }, flags: [], level: 'light', note: '' };
    if (!raw) return empty;
    const format = detectFormat(raw);
    let base = null;
    if (format === 'Dashboard Studio' || format === 'JSON') {
        const jt = dsJsonText(raw);
        if (jt) base = analyzeStudio(jt);
    }
    if (!base && (format === 'Simple XML' || format === 'Dashboard Studio')) {
        base = analyzeSxml(raw);
    }
    if (!base) return Object.assign({}, empty, { format });

    const { range, sawToken } = worstRange(base.ranges);
    const flags = [];
    if (range.kind === 'realtime') flags.push('Real-time');
    else if (range.kind === 'alltime') flags.push('All-time');
    else if (range.kind === 'span' && range.secs >= 30 * DAY) flags.push('Wide range (' + range.label + ')');
    if (base.panels >= 10) flags.push(base.panels + ' panels');
    if (base.searches >= 8) flags.push(base.searches + ' searches');

    let level = 'light';
    if (base.panels >= 10 || base.searches >= 8 || (range.kind === 'span' && range.secs >= 7 * DAY)) level = 'moderate';
    if (range.kind === 'realtime' || range.kind === 'alltime' || base.panels >= 20 || base.searches >= 16 || (range.kind === 'span' && range.secs >= 90 * DAY)) level = 'heavy';

    let note = '';
    if (sawToken && range.kind !== 'realtime' && range.kind !== 'alltime') {
        note = 'Some time ranges are set by inputs at runtime, so actual cost may be higher.';
    }

    return { format: base.format, panels: base.panels, searches: base.searches, dataSources: base.dataSources, range, flags, level, note };
}

// Combined level of two analyses (the worse of the two), for the compare gate.
export function combineLevel(a, b) {
    const rank = { light: 0, moderate: 1, heavy: 2 };
    const la = a ? rank[a.level] : 0;
    const lb = b ? rank[b.level] : 0;
    return ['light', 'moderate', 'heavy'][Math.max(la, lb)];
}
