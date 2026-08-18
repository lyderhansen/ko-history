import React from 'react';
import { SplunkThemeProvider } from '@splunk/themes';
import { oneshot, upsertView, restoreView, upsertSavedSearch, viewExists, savedSearchExists, savedSearchUrl, listApps, viewUrl, previewUrl, splQuote, VIEW_SOURCES, REPORT_SOURCES, sourcesForClass, PREVIEW_APP, SLOT_BASELINE, SLOT_TARGET, restoreKO, koManagerUrl, readRestoreSettings, canWritePreviewSlots, canCreateIn } from '../util/splunkRest';
import { isRestoreAllowed, restoreBlockReason } from '../util/restoreSettings';
import { parseMarker } from '../util/markerParse';
import { versionSearchTerms } from '../util/versionSearchTerms';
import { toLines, lineDiff } from '../util/diff';
import { analyze } from '../util/heaviness';
import { parseSchematic, diffSchematic } from '../util/schematic';
import { startHighlightPoll, clearHighlights } from '../util/highlightInject';
import SourceView from './SourceView';
import { PAL, MONO, OpenIcon, Flag, Drawer, DrawerLead, Tabs, Seg, Notice, StatsList, kitStyles, FocusCtrl, HoverBtn, CostFlag, ProgressBar, SplCode } from './PanelKit';
// VersionTimeline is intentionally unwired (kept in the repo for future use).

// Inject spinner keyframes once into the document head.
(function injectSpinnerKeyframes() {
    const STYLE_ID = 'kohist-spinner-kf';
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = '@keyframes kohist-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
}());

// Small inline spinner (12–14 px ring). Renders as inline-block so it flows
// naturally beside text. color defaults to a dim ring.
function Spinner({ size = 13, color = 'rgba(200,204,208,0.7)' }) {
    return (
        <span
            aria-hidden="true"
            style={{
                display: 'inline-block',
                width: size,
                height: size,
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.12)',
                borderTopColor: color,
                animation: 'kohist-spin 0.7s linear infinite',
                verticalAlign: 'middle',
                flexShrink: 0,
            }}
        />
    );
}

// Upper bound on a versions fetch. Past this the request is aborted and the
// panel shows a recoverable error with Retry, rather than spinning forever.
const VERSIONS_TIMEOUT_MS = 30000;
// Elapsed seconds before the loading row starts showing a counter.
const ELAPSED_AFTER_S = 5;

// Quiet Focus small-button builders shared by the compare modal, CompareColumn,
// and BlendView (all module-level functions, outside the WrapperApp closure —
// they can't reach the panel's own btnPrimary/btnRestore builders, so these are
// standalone equivalents at the small toolbar size: padding 5px 11px, 12px).
/* Splunk's own chrome renders at z-index 10000 (the only z-index in
 * @splunk/react-page). Before the modern nav that never mattered, because the
 * classic bar sat above the page rather than beside it; with the left sidebar
 * our modals were painting UNDERNEATH it and losing their left edge.
 *
 * Derived from that value rather than picked, so the reason survives: anything
 * of ours that must cover the chrome goes above CHROME_Z. */
const CHROME_Z = 10000;
const MODAL_Z = CHROME_Z + 100;
/* Modals opened from inside another modal (approval over compare). */
const MODAL_Z_ELEVATED = MODAL_Z + 100;

const KIT = kitStyles();
function btnPrimarySmall(enabled) {
    return {
        ...KIT.btnBase, width: 'auto', padding: '5px 11px', fontSize: 12,
        background: enabled ? PAL.primaryBtn : PAL.field, color: enabled ? PAL.primaryBtnText : PAL.text3,
        transition: 'background .12s, border-color .12s',
    };
}
function btnRestoreSmall(enabled) {
    return {
        ...KIT.btnBase, width: 'auto', padding: '5px 11px', fontSize: 12,
        background: enabled ? PAL.restoreBg : PAL.field, color: enabled ? PAL.restoreText : PAL.text3,
        // See disabledCue(): btnBase always sets cursor:pointer, so a disabled
        // button reads as live unless this is overridden.
        borderColor: enabled ? PAL.restoreBorder : PAL.edgeSoft,
        opacity: enabled ? 1 : 0.5,
        cursor: enabled ? 'pointer' : 'not-allowed',
        transition: 'background .12s, border-color .12s, opacity .12s',
    };
}
// Ghost button for BlendView's zoom/align controls (ⓘ-notice-adjacent chrome,
// not a primary/restore action). `active` lifts it slightly when the control
// represents a non-default state (e.g. zoom !== 100%, alignment nudged).
function ghostSmall(active) {
    return {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: active ? PAL.panel2 : 'transparent',
        border: `1px solid ${active ? PAL.text3 : PAL.edge}`,
        color: active ? PAL.text : PAL.text2,
        borderRadius: 5, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
        transition: 'background .12s, border-color .12s, color .12s',
    };
}
// In-iframe highlight colors — same tokens as the legend swatches, passed to
// startHighlightPoll so overlay boxes and the legend can never drift apart.
const HL_COLORS = {
    added: { border: PAL.diffAdded, glow: PAL.diffAddedBg },
    moved: { border: PAL.diffModified, glow: PAL.diffModifiedBg },
    retitled: { border: PAL.diffModified, glow: PAL.diffModifiedBg },
    removed: { border: PAL.diffRemoved, glow: PAL.diffRemovedBg },
    changed: { border: PAL.diffModified, glow: PAL.diffModifiedBg },
};

// Mono font stack for code/diff areas — imported from PanelKit so the panel
// and the compare/diff modals share exactly one definition (was two subtly
// different stacks before).
// Map a panel change kind to a show/hide group (added / modified / removed).
const KIND_GROUP = { added: 'added', moved: 'modified', retitled: 'modified', removed: 'removed' };
// Sans-serif stack for all prose/UI chrome (modals inherit serif from the page otherwise).
const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// SLOT_BASELINE / SLOT_TARGET are imported from splunkRest.js — they are
// per-user suffixed at module load time (e.g. kohist_cmp_baseline_jdoe).
const SOURCE_LIST = VIEW_SOURCES.map(splQuote).join(',');
const REPORT_SOURCE_LIST = REPORT_SOURCES.map(splQuote).join(',');
// Map a marker ko_class to its SPL-quoted source IN-list for the wrapper's
// version-fetch. Delegates to the splunkRest.sourcesForClass single source of
// truth; unknown (future) classes fall back to "*", title-scoped.
function sourceListForClass(koClass) {
    const sources = sourcesForClass(koClass);
    if (!sources) return '"*"';
    return sources.map(splQuote).join(',');
}

// The KO "content" fields, in priority order — the primary code a generic KO
// carries (a macro's definition, an event type's search, an extraction's
// regex, …). Mirrors the ko_viewer viz's CODE list so the wrapper and the
// in-dashboard card agree on what counts as content.
const KO_CODE_FIELDS = [
    ['definition', 'Definition'], ['search', 'Search'], ['regex', 'Regex'],
    ['value', 'Value'], ['eval', 'Eval expression'], ['template', 'Template'],
];
// First present content field for a KO field map → {key,label,value}, else null.
function koContentField(fields) {
    const f = fields || {};
    for (let i = 0; i < KO_CODE_FIELDS.length; i++) {
        const k = KO_CODE_FIELDS[i][0];
        if (f[k] != null && String(f[k]) !== '') return { key: k, label: KO_CODE_FIELDS[i][1], value: String(f[k]) };
    }
    return null;
}
// Human label for a generic KO type (macro → "Macro", eventtype → "Event type").
function prettyKoType(fields) {
    const t = String((fields || {}).type || '').toLowerCase();
    const MAP = { macro: 'Macro', eventtype: 'Event type', lookup: 'Lookup', tag: 'Tag', fieldextraction: 'Field extraction', extraction: 'Field extraction' };
    if (MAP[t]) return MAP[t];
    if (!t) return 'Knowledge object';
    return t.charAt(0).toUpperCase() + t.slice(1);
}

// Saved-search fields we surface per version. Unlike a dashboard (one XML blob),
// a report/alert is ~30 scattered config fields; this is the curated set an admin
// cares about (SPL, schedule, actions, alert config) plus the action.*/alert.*
// wildcards so nothing material is silently dropped. Tabled in SPL → returned as
// row-object keys (dotted names like "action.email.to" survive intact).
const SS_FIELDS = (
    'search disabled is_scheduled cron_schedule realtime_schedule schedule_window schedule_priority ' +
    'dispatch.earliest_time dispatch.latest_time description alert_type ' +
    'alert_comparator alert_threshold alert_condition actions owner sharing ' +
    'action.* alert.*'
);

// Version-fetch for SAVED SEARCHES (reports/alerts). Mirrors versionsSpl but
// targets the report sources and keeps the saved-search FIELDS (no XML extract —
// there is no data="…" envelope). Backup rows carry `search`; audit DELETE/MOVE
// rows carry only `file`/`method` (no appName), so the title coalesces from both
// and the app filter tolerates audit rows so deletions still appear in history.
function versionsSplSavedSearch(title, appName) {
    return (
        `index=\`ko_history_index\` source IN (${REPORT_SOURCE_LIST}) ` + versionSearchTerms(title) + ' ' +
        `| eval title=coalesce(title,file), appName=coalesce(appName,app) ` +
        `| search title=${splQuote(title)} ` +
        `| where appName=${splQuote(appName)} OR isnull(appName) ` +
        // backup rows -> "updated"; audit rows already carry method (DELETE/MOVE).
        `| eval method=coalesce(method,if(isnotnull('search'),"updated","–")) ` +
        `| eval epoch=_time ` +
        `| sort - epoch | head 200 ` +
        `| table epoch method user ${SS_FIELDS}`
    );
}

// Build the structured version object from a saved-search result row. Keeps every
// returned field (dotted action.*/alert.* keys intact) and tags whether the row
// is a real config snapshot (`isConfig`, has SPL) vs an audit-only DELETE/MOVE
// marker. Downstream (#8 compare, #9 restore) consume `.fields`.
function extractSavedSearch(row) {
    const fields = {};
    Object.keys(row || {}).forEach((k) => {
        if (k === 'epoch' || k === 'method' || k.charAt(0) === '_') return;
        fields[k] = row[k];
    });
    const isConfig = !!(fields.search && String(fields.search).length);
    return { fields, isConfig };
}

// Version-fetch for GENERIC non-dashboard KOs (macros + future types). Like the
// saved-search fetch but tables the union of content fields (definition/args/
// iseval + the other KO_CODE_FIELDS) so one query serves every type. sourceList
// scopes to the class's sources (falls back to "*", title-scoped).
function versionsSplGeneric(title, appName, sourceList) {
    return (
        `index=\`ko_history_index\` source IN (${sourceList}) NOT source="ko_usage" ` + versionSearchTerms(title) + ' ' +
        `| eval title=coalesce(title,file), appName=coalesce(appName,app) ` +
        `| search title=${splQuote(title)} ` +
        `| where appName=${splQuote(appName)} OR isnull(appName) ` +
        `| eval method=coalesce(method,"updated") ` +
        `| eval epoch=_time ` +
        `| sort - epoch | head 200 ` +
        `| table epoch method user type definition args iseval search regex value eval template ` +
        `description priority tags color stanza attribute extract_kind ` +
        `filename lookup_type collection external_cmd fields_list case_sensitive_match disabled owner sharing`
    );
}

// Structured version object for a generic KO row. isConfig = carries a content
// field (vs an audit-only DELETE/MOVE marker).
function extractGeneric(row) {
    const fields = {};
    Object.keys(row || {}).forEach((k) => {
        if (k === 'epoch' || k === 'method' || k.charAt(0) === '_') return;
        fields[k] = row[k];
    });
    return { fields, isConfig: !!koContentField(fields) };
}

// Relabel the chronologically FIRST backup snapshot in a versions array as
// "created". The array is newest-first (sorted desc before fetching), so the
// last element is the oldest. If its method is "updated" (a backup snapshot,
// not DELETE/MOVE) it must be the earliest record we have — label it "created"
// to match the dashboard's HISTORY_TAIL logic. All other entries keep "updated".
// The sentinel 2010 entry always has method="updated", so it is also relabeled.
function relabelFirstCreated(arr) {
    if (!arr || arr.length === 0) return arr;
    const last = arr[arr.length - 1];
    if ((last.method || '').toLowerCase() !== 'updated') return arr; // DELETE/MOVE — leave as-is
    const relabeled = arr.slice(0, -1).concat([Object.assign({}, last, { method: 'created' })]);
    return relabeled;
}

function versionsSpl(title, appName) {
    // Fetch _raw and extract the XML in JS (the auto-extracted `data` field
    // truncates at an escaped quote for some dashboards). _raw is complete.
    return (
        `index=\`ko_history_index\` source IN (${SOURCE_LIST}) ` + versionSearchTerms(title) + ' ' +
        `| eval title=coalesce(title,file,dashboard), appName=coalesce(appName,app) ` +
        `| search title=${splQuote(title)} appName=${splQuote(appName)} ` +
        // derive method like the dashboard (backup events carry "updated") so the
        // dropdown shows it instead of an empty dash; emit an explicit epoch since
        // JSON renders _time as an ISO string that won't compare to the epoch token.
        `| rex field=_raw "(?<m_upd>updated)" | eval method=coalesce(method,m_upd) ` +
        `| eval epoch=_time | table epoch method user _raw | sort - epoch | head 200`
    );
}

function extractXml(raw) {
    const s = String(raw || '');
    const start = s.indexOf('data="');
    if (start < 0) return '';
    let body = s.slice(start + 6);
    const end = body.indexOf('", type=');
    if (end >= 0) body = body.slice(0, end);
    // Some KOs are stored with leading whitespace before the XML (eai:data
    // beginning with "\n<dashboard ...>"). Splunk's field extraction trims it
    // but _raw keeps it — trim so the renderable check (charAt(0) === '<')
    // doesn't reject valid snapshots.
    return unescapeData(body).replace(/^\s+/, '');
}

function unescapeData(s) {
    return String(s || '').replace(/\\(.)/g, '$1');
}

function isDsXml(xml) {
    return /<definition/.test(String(xml || ''));
}

function fmtTime(epoch) {
    const n = Number(epoch);
    if (!n) return String(epoch || '');
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sameEpoch = (a, b) => Math.floor(Number(a)) === Math.floor(Number(b));

function relTime(epoch) {
    const n = Number(epoch);
    if (!n) return '–';
    let s = Math.floor(Date.now() / 1000 - n);
    if (s < 0) s = 0;
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
}

function durStr(secs) {
    secs = Math.max(0, Math.floor(Number(secs) || 0));
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// "Report" / "Scheduled report" / "Alert" from saved-search config fields.
function prettySsType(fields) {
    const f = fields || {};
    const at = String(f.alert_type || '').toLowerCase();
    if (at && at !== 'always') return 'Alert';
    if (String(f.is_scheduled) === '1') return 'Scheduled report';
    return 'Report';
}

// Read-only field summary for the selected saved-search target version — the data
// #7 now fetches. Status, type, schedule, alert condition, trigger-action chips,
// and the SPL. Side-by-side compare (field + SPL diff) and restore are #8/#9.
function SavedSearchSummary({ ver, hideNote }) {
    if (!ver || !ver.fields) {
        return <div style={{ color: '#9aa0a6', marginTop: 12, fontSize: 12 }}>No config snapshot for this version (audit-only marker).</div>;
    }
    const f = ver.fields;
    const disabled = String(f.disabled) === '1';
    const scheduled = String(f.is_scheduled) === '1';
    const isAlert = f.alert_type && String(f.alert_type).toLowerCase() !== 'always';
    const actions = String(f.actions || '').split(',').map((s) => s.trim()).filter(Boolean);
    const row = (k, v) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ color: '#9aa0a6' }}>{k}</span>
            <span style={{ textAlign: 'right' }}>{v}</span>
        </div>
    );
    const head = { fontSize: 11, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 };
    return (
        <div style={{ marginTop: 14 }}>
            <div style={head}>Latest version · config</div>
            {row('Status', <b style={{ color: disabled ? '#f85149' : '#81c995' }}>{disabled ? 'Disabled' : 'Enabled'}</b>)}
            {row('Type', prettySsType(f))}
            {row('Schedule', scheduled ? (f.cron_schedule || '–') : 'Not scheduled')}
            {isAlert ? row('Alert condition', (`${f.alert_comparator || ''} ${f.alert_threshold || ''}`).trim() || (f.alert_condition || '–')) : null}
            <div style={{ marginTop: 8 }}>
                <div style={head}>Trigger actions</div>
                {actions.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {actions.map((a) => (
                            <span key={a} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(0,164,253,0.16)', border: '1px solid rgba(0,164,253,0.5)', color: '#8ab4f8' }}>{a}</span>
                        ))}
                    </div>
                ) : <div style={{ color: '#6b7177', fontSize: 12 }}>None</div>}
            </div>
            <div style={{ marginTop: 10 }}>
                <div style={head}>Search (SPL)</div>
                {f.search ? (
                    <SplCode
                        code={f.search}
                        style={{ maxHeight: 180, overflow: 'auto', background: PAL.field,
                            border: `1px solid ${PAL.edgeSoft}`, borderRadius: 6, padding: '8px 10px' }}
                    />
                ) : (
                    <div style={{ color: PAL.text3, fontSize: 12 }}>No search string captured.</div>
                )}
            </div>
            {hideNote ? null : (
                <div style={{ marginTop: 12, background: 'rgba(138,180,248,0.1)', border: '1px solid rgba(138,180,248,0.4)', color: '#9bb8e8', borderRadius: 4, padding: '8px 10px', fontSize: 11, lineHeight: 1.5 }}>
                    Pick an <b style={{ color: '#8ab4f8' }}>older version</b> and a <b style={{ color: '#81c995' }}>newer version</b> above, then <b>Compare</b> for a side-by-side card view with field and SPL diffs. Use <b>Restore</b> to recover any captured version.
                </div>
            )}
        </div>
    );
}

// Read-only summary for a GENERIC KO version (macro + future types). Header
// (type seal, app/owner/sharing/updated), the primary content field, and a
// details list of the remaining fields. Mirrors the ko_viewer viz's generic card.
function GenericSummary({ ver, hideNote }) {
    if (!ver || !ver.fields) {
        return <div style={{ color: '#9aa0a6', marginTop: 12, fontSize: 12 }}>No content snapshot for this version (audit-only marker).</div>;
    }
    const f = ver.fields;
    const content = koContentField(f);
    const head = { fontSize: 11, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 };
    const SKIP = { title: 1, appName: 1, app: 1, owner: 1, sharing: 1, updated: 1, type: 1 };
    const details = Object.keys(f)
        .filter((k) => !SKIP[k] && (!content || k !== content.key) && f[k] != null && String(f[k]) !== '')
        .sort();
    return (
        <div style={{ marginTop: 14 }}>
            <div style={head}>{prettyKoType(f)} · newer version</div>
            {content ? (
                <div style={{ marginTop: 8 }}>
                    <div style={head}>{content.label}</div>
                    <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', background: '#0e1116', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '8px 10px', fontFamily: MONO, fontSize: 12, color: '#d6dee7', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content.value}</pre>
                </div>
            ) : <div style={{ color: '#6b7177', fontSize: 12 }}>No content field captured for this KO.</div>}
            {details.length ? (
                <div style={{ marginTop: 10 }}>
                    <div style={head}>Details</div>
                    {details.map((k) => (
                        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <span style={{ color: '#9aa0a6', fontFamily: MONO }}>{k}</span>
                            <span style={{ textAlign: 'right', wordBreak: 'break-word' }}>{String(f[k])}</span>
                        </div>
                    ))}
                </div>
            ) : null}
            {hideNote ? null : (
                <div style={{ marginTop: 12, background: 'rgba(138,180,248,0.1)', border: '1px solid rgba(138,180,248,0.4)', color: '#9bb8e8', borderRadius: 4, padding: '8px 10px', fontSize: 11, lineHeight: 1.5 }}>
                    Pick an <b style={{ color: '#8ab4f8' }}>older version</b> and a <b style={{ color: '#81c995' }}>newer version</b> above, then <b>Compare</b> for a side-by-side view with field and content diffs.
                </div>
            )}
        </div>
    );
}

// Dispatch a KO version to the right summary: saved searches get the bespoke
// report/alert profile; everything else gets the generic card.
function KOSummary({ ver, hideNote }) {
    const isSS = ver && ver.fields && (String(ver.fields.type || '').toLowerCase() === 'savedsearch'
        || (ver.fields.search != null && ver.fields.alert_type != null));
    return isSS ? <SavedSearchSummary ver={ver} hideNote={hideNote} /> : <GenericSummary ver={ver} hideNote={hideNote} />;
}

// Admin-priority ordering for the saved-search field diff: the fields that
// actually matter (SPL, schedule, alert config, actions) float to the top; the
// action.*/alert.* detail keys group after; everything else last.
const SS_FIELD_PRIORITY = [
    'search', 'disabled', 'is_scheduled', 'cron_schedule', 'schedule_window', 'schedule_priority',
    'dispatch.earliest_time', 'dispatch.latest_time', 'description',
    'alert_type', 'alert_comparator', 'alert_threshold', 'alert_condition', 'actions',
];
function ssFieldRank(k) {
    const i = SS_FIELD_PRIORITY.indexOf(k);
    if (i >= 0) return i;
    if (k.indexOf('action.') === 0) return 100;
    if (k.indexOf('alert.') === 0) return 120;
    return 200;
}
const ssNorm = (v) => (v == null ? '' : String(v));
// Build the unified field-diff row set from two version field maps.
function ssFieldRows(baseF, targetF) {
    const keys = {};
    Object.keys(baseF || {}).forEach((k) => { keys[k] = 1; });
    Object.keys(targetF || {}).forEach((k) => { keys[k] = 1; });
    return Object.keys(keys)
        .map((k) => {
            const a = (baseF || {})[k];
            const b = (targetF || {})[k];
            const an = ssNorm(a);
            const bn = ssNorm(b);
            let status = 'same';
            if (an !== bn) status = an === '' ? 'added' : bn === '' ? 'removed' : 'changed';
            return { k, a, b, status };
        })
        .sort((x, y) => ssFieldRank(x.k) - ssFieldRank(y.k) || x.k.localeCompare(y.k));
}

// KO compare modal (#8, generalized for Phase 3): three tabs — Cards (two
// summaries side by side), Field diff (every changed field, admin-priority
// first), and a content diff (line diff of the KO's primary content field —
// `search` for a saved search, `definition` for a macro, … — via lineDiff).
function SavedSearchCompare({ title, baseVer, targetVer, onClose, onRestore }) {
    const [tab, setTab] = React.useState('fields');
    const [showSame, setShowSame] = React.useState(false);
    const baseF = (baseVer && baseVer.fields) || {};
    const targetF = (targetVer && targetVer.fields) || {};
    const rows = React.useMemo(() => ssFieldRows(baseF, targetF), [baseVer, targetVer]);
    const changed = rows.filter((r) => r.status !== 'same');
    // Primary content field (search/definition/…) — diff the same key on both sides.
    const cf = koContentField(targetF) || koContentField(baseF);
    const contentKey = cf ? cf.key : 'search';
    const contentLabel = cf ? (cf.key === 'search' ? 'SPL' : cf.label) : 'SPL';
    const splOps = React.useMemo(
        () => lineDiff(ssNorm(baseF[contentKey]).split('\n'), ssNorm(targetF[contentKey]).split('\n')),
        [baseVer, targetVer, contentKey]
    );
    const splChanged = splOps.some((o) => o.t !== 'eq');

    // Quiet Focus diff encoding — same tokens as the dashboard-compare legend
    // (spec §6), so a saved-search field's status reads identically everywhere.
    const STATUS_COLOR = { added: PAL.diffAdded, removed: PAL.diffRemoved, changed: PAL.diffModified, same: PAL.text3 };
    const cell = { padding: '6px 8px', fontFamily: MONO, fontSize: 12, verticalAlign: 'top', borderTop: `1px solid ${PAL.edgeSoft}`, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
    const baseOk = !!(baseVer && baseVer.isConfig);
    const targetOk = !!(targetVer && targetVer.isConfig);

    return (
        <Modal title={`Compare: ${title}`} onClose={onClose}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}`, flexWrap: 'wrap' }}>
                <Seg
                    items={[
                        ['fields', `Field diff (${changed.length})`],
                        ['spl', `${contentLabel} diff`],
                        ['cards', 'Cards'],
                    ]}
                    active={tab}
                    onSelect={setTab}
                />
                {onRestore ? (
                    <React.Fragment>
                        <span style={{ flex: 1 }} />
                        <span style={{ color: PAL.text3, fontSize: 11.5, marginRight: 2 }}>Restore</span>
                        <HoverBtn base={btnRestoreSmall(baseOk)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!baseOk} title="Restore the older version" onClick={() => baseOk && onRestore('baseline')}>
                            ⟲ Older
                        </HoverBtn>
                        <HoverBtn base={btnRestoreSmall(targetOk)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!targetOk} title="Restore the newer version" onClick={() => targetOk && onRestore('target')}>
                            ⟲ Newer
                        </HoverBtn>
                    </React.Fragment>
                ) : null}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
                {tab === 'fields' ? (
                    <div>
                        {changed.length === 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: PAL.text2, fontSize: 13, marginBottom: 10 }}>
                                <span style={{ color: PAL.diffAdded, fontSize: 12 }}>✓</span> No field changes between these two versions.
                            </div>
                        ) : null}
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                            <thead>
                                <tr style={{ fontSize: 11, color: PAL.text3, letterSpacing: 0.4 }}>
                                    <th style={{ textAlign: 'left', padding: '4px 8px', width: '24%' }}>Field</th>
                                    <th style={{ textAlign: 'left', padding: '4px 8px', width: '38%' }}>Older</th>
                                    <th style={{ textAlign: 'left', padding: '4px 8px', width: '38%' }}>Newer</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(showSame ? rows : changed).map((r) => (
                                    <tr key={r.k}>
                                        <td style={{ ...cell, color: PAL.text2 }}>
                                            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[r.status], marginRight: 6 }} />
                                            {r.k}
                                        </td>
                                        <td style={{ ...cell, color: r.status === 'added' ? PAL.text3 : PAL.text, background: r.status !== 'same' ? PAL.diffRemovedBg : 'transparent' }}>{ssNorm(r.a) || (r.status === 'added' ? '–' : '')}</td>
                                        <td style={{ ...cell, color: r.status === 'removed' ? PAL.text3 : PAL.text, background: r.status !== 'same' ? PAL.diffAddedBg : 'transparent' }}>{ssNorm(r.b) || (r.status === 'removed' ? '–' : '')}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <HoverBtn base={{ ...ghostSmall(showSame), marginTop: 12 }} hover={{ color: PAL.text, borderColor: PAL.text3 }} onClick={() => setShowSame((s) => !s)}>
                            {showSame ? 'Hide unchanged' : `Show unchanged (${rows.length - changed.length})`}
                        </HoverBtn>
                    </div>
                ) : null}

                {tab === 'spl' ? (
                    <div>
                        {!splChanged ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: PAL.text2, fontSize: 13, marginBottom: 10 }}>
                                <span style={{ color: PAL.diffAdded, fontSize: 12 }}>✓</span> {contentLabel} is identical between these two versions.
                            </div>
                        ) : null}
                        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, background: PAL.field, border: `1px solid ${PAL.edge}`, borderRadius: 4, padding: '10px 12px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {splOps.map((o, i) => (
                                <div key={i} style={{ background: o.t === 'add' ? PAL.diffAddedBg : o.t === 'del' ? PAL.diffRemovedBg : 'transparent', color: o.t === 'add' ? PAL.diffAdded : o.t === 'del' ? PAL.diffRemoved : PAL.text2 }}>
                                    <span style={{ color: PAL.text3, userSelect: 'none' }}>{o.t === 'add' ? '+ ' : o.t === 'del' ? '- ' : '  '}</span>{o.line || ' '}
                                </div>
                            ))}
                        </pre>
                    </div>
                ) : null}

                {tab === 'cards' ? (
                    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${PAL.edgeSoft}`, borderRadius: 6, padding: '4px 12px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3 }}>Older</span>
                                <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(baseVer._time)}</span>
                            </div>
                            <KOSummary ver={baseVer} hideNote />
                        </div>
                        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${PAL.edgeSoft}`, borderRadius: 6, padding: '4px 12px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3 }}>Newer</span>
                                <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(targetVer._time)}</span>
                            </div>
                            <KOSummary ver={targetVer} hideNote />
                        </div>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

export default function WrapperApp() {
    React.useEffect(() => {
        const ph = document.documentElement.style.background;
        const pb = document.body.style.background;
        document.documentElement.style.background = '#171d21';
        document.body.style.background = '#171d21';
        return () => {
            document.documentElement.style.background = ph;
            document.body.style.background = pb;
        };
    }, []);

    // Selection seeded from the embedded dashboard; overridable via the dropdowns.
    //  - main KO table click  -> selected KO (target = its latest version)
    //  - "Versions of ..." click -> baseline version
    const [sel, setSel] = React.useState(null); // {title, appName}
    const [selectedEpoch, setSelectedEpoch] = React.useState(null);

    // Which KO types an admin has enabled restore for, from ko_history.conf.
    // Fetched once: it is an instance-wide setting, not per selection.
    // 'loading' | 'ok' | 'error' — the wrapper distinguishes the three so a
    // greyed-out Restore button can say which of them is the reason.
    const [restoreSettingsState, setRestoreSettingsState] = React.useState('loading');
    const [restoreEnabled, setRestoreEnabled] = React.useState([]);

    // Can this user write the preview slot views? Preview and compare write two
    // scratch views into ko_history and iframe them, and metadata/default.meta
    // grants that to admin and sc_admin only (deliberately: the vizs export
    // system-wide, so a wider grant would be a view-overwrite primitive reachable
    // fleet-wide). Without this probe a non-admin gets the full approval dialog
    // and then a 403, which is the same looks-live-does-nothing trap as before.
    // null = still checking.
    const [canPreview, setCanPreview] = React.useState(null);
    // Same question for the app a restore would write INTO, re-checked whenever
    // the target app changes. null = unknown or still checking.
    const [canWriteTarget, setCanWriteTarget] = React.useState(null);

    const [versions, setVersions] = React.useState([]);
    const [versionsErr, setVersionsErr] = React.useState('');
    const [loadingVersions, setLoadingVersions] = React.useState(false);
    // Seconds the in-flight versions fetch has been running (0 when idle).
    const [versionsElapsed, setVersionsElapsed] = React.useState(0);
    // True between a click inside the dashboard and the marker read that
    // follows it, so the progress bar appears on click rather than after.
    const [selPending, setSelPending] = React.useState(false);
    const [baselineMiss, setBaselineMiss] = React.useState(false);
    const [versionsFetchKey, setVersionsFetchKey] = React.useState(0); // bump to retry
    const [baseIdx, setBaseIdx] = React.useState(1);
    const [targetIdx, setTargetIdx] = React.useState(0);

    // ── Quiet Focus panel UI state (presentation only) ──
    const [paneTab, setPaneTab] = React.useState('compare'); // 'compare' | 'restore'
    const [openFlag, setOpenFlag] = React.useState(null); // null | 'cost' | 'render'
    const [swapHover, setSwapHover] = React.useState(false); // ⇅ swap button hover (contract .swap button:hover)

    const [approval, setApproval] = React.useState(null);
    const [compare, setCompare] = React.useState(null);
    const [cmpTab, setCmpTab] = React.useState('visual');
    const [paneOpen, setPaneOpen] = React.useState(false); // start collapsed; user opens "‹ Preview & Compare"
    const [runBase, setRunBase] = React.useState(false);
    const [runTarget, setRunTarget] = React.useState(false);
    const [overlays, setOverlays] = React.useState(true);
    const [kinds, setKinds] = React.useState({ added: true, modified: true, removed: true });
    const [visualMode, setVisualMode] = React.useState('boxes'); // 'boxes' | 'blend' (#44)
    const [hasBlended, setHasBlended] = React.useState(false); // true once blend mode is first activated this session
    const [ssCompare, setSsCompare] = React.useState(false); // saved-search compare modal (#8)

    // ── restore (recover a captured version back into Splunk as a real KO) ──
    const [apps, setApps] = React.useState([]);
    const [appsLoadErr, setAppsLoadErr] = React.useState(false);
    const [restoreIdx, setRestoreIdx] = React.useState(0);
    const [restoreApp, setRestoreApp] = React.useState('');
    const [restoreName, setRestoreName] = React.useState('');
    const [restore, setRestore] = React.useState(null); // {busy,error,done}
    // Live name-availability check: null = unknown/checking, true = exists, false = free.
    const [restoreNameExists, setRestoreNameExists] = React.useState(null);
    // Whether the user has explicitly clicked "Overwrite existing" to opt-in.
    const [restoreOverwrite, setRestoreOverwrite] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        listApps()
            .then((list) => { if (!cancelled) setApps(list); })
            .catch(() => { if (!cancelled) setAppsLoadErr(true); });
        return () => { cancelled = true; };
    }, []);

    // Restore is opt-in, so this fails closed: any error leaves the enabled list
    // empty and marks the state 'error', which blocks restore and lets the
    // button explain that the settings could not be read rather than implying
    // an admin turned the feature off.
    //
    // Re-read whenever the tab regains focus, not only on mount. The settings
    // live on a different page, so the normal flow is: open the wrapper, go
    // enable restore, come back. A mount-only fetch means the admin returns to a
    // wrapper still insisting restore is off, naming the page they just saved.
    // It matters in the other direction too: switching restore OFF should reach
    // tabs that are already open rather than waiting for a reload.
    React.useEffect(() => {
        let cancelled = false;
        let inFlight = false;

        const load = () => {
            if (cancelled || inFlight) return;
            inFlight = true;
            readRestoreSettings()
                .then((res) => {
                    if (cancelled) return;
                    setRestoreEnabled(res.enabled);
                    setRestoreSettingsState('ok');
                })
                .catch((e) => {
                    if (cancelled) return;
                    setRestoreEnabled([]);
                    // A permission failure is not a transient one. Telling the
                    // user to reload when reloading can never help is worse than
                    // saying nothing.
                    setRestoreSettingsState(e && e.code === 'FORBIDDEN' ? 'forbidden' : 'error');
                })
                .then(() => { inFlight = false; });
        };

        load();
        const onVisible = () => {
            if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load();
        };
        window.addEventListener('focus', onVisible);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            window.removeEventListener('focus', onVisible);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    // One cheap probe, once: may this user create the preview slot views?
    React.useEffect(() => {
        let cancelled = false;
        canWritePreviewSlots()
            .then((yes) => { if (!cancelled) setCanPreview(!!yes); })
            .catch(() => { if (!cancelled) setCanPreview(false); });
        return () => { cancelled = true; };
    }, []);

    // And may they create objects in whichever app they have picked to restore
    // into? Re-probed on every change of the target app dropdown.
    React.useEffect(() => {
        if (!restoreApp) { setCanWriteTarget(null); return undefined; }
        let cancelled = false;
        setCanWriteTarget(null);
        // Not `isSaved`: that is derived further down the component, so reading
        // it here would hit its temporal dead zone. `sel` is state, declared at
        // the top, and carries the same information.
        const savedSearch = !!(sel && sel.koClass === 'savedsearch');
        canCreateIn(restoreApp, savedSearch ? 'saved/searches' : 'data/ui/views')
            .then((yes) => { if (!cancelled) setCanWriteTarget(!!yes); })
            .catch(() => { if (!cancelled) setCanWriteTarget(false); });
        return () => { cancelled = true; };
    }, [restoreApp, sel]);

    // ── embedded ko_version_ds dashboard (same origin) ──
    const dashUrl = React.useMemo(() => {
        const seg = window.location.pathname.split('/').filter(Boolean);
        const loc = seg[0] || 'en-US';
        const chrome = 'hideEdit=true&hideTitle=true&hideChrome=true&hideSplunkBar=true&hideAppBar=true&hideFooter=true';
        return `/${loc}/app/${PREVIEW_APP}/ko_version_ds?${chrome}`;
    }, []);

    const iframeRef = React.useRef(null);
    const lastSelRef = React.useRef('');
    // Cached reference to the viz_link marker node inside the DS iframe.
    // Reset to null whenever we detect the node is no longer live.
    const markerNodeRef = React.useRef(null);
    // Counter used to rate-limit the expensive full-body fallback path.
    const fallbackTickRef = React.useRef(0);
    React.useEffect(() => {
        const timeouts = [];
        const attached = { doc: null };

        const readMarker = () => {
            try {
                const doc = iframeRef.current && iframeRef.current.contentDocument;
                if (!doc || !doc.body) return;

                // --- targeted marker-node lookup (no layout) ---
                // The DS dashboard has a splunk.markdown viz with id "viz_link".
                // DS renders viz containers with one of several data attributes
                // keyed to the viz id; we try a ladder from most- to least-specific.
                // A cached node is reused but revalidated each tick:
                //   1. isConnected — detached nodes (DS re-render) are dropped.
                //   2. ownerDocument — iframe reload swaps the document entirely.
                let markerNode = markerNodeRef.current;
                if (
                    markerNode &&
                    (!markerNode.isConnected || markerNode.ownerDocument !== doc)
                ) {
                    markerNode = null;
                    markerNodeRef.current = null;
                }

                if (!markerNode) {
                    // Selector ladder: DS 8.x/9.x attribute names, then substring fallback.
                    const VIZ_ID = 'viz_link';
                    const selectors = [
                        '[data-input-id="' + VIZ_ID + '"]',
                        '[data-test-input-id="' + VIZ_ID + '"]',
                        '[data-viz-id="' + VIZ_ID + '"]',
                        '[id="' + VIZ_ID + '"]',
                    ];
                    for (let s = 0; s < selectors.length; s++) {
                        let candidate = null;
                        try { candidate = doc.querySelector(selectors[s]); } catch (e) { /* */ }
                        if (candidate && candidate.isConnected) {
                            markerNode = candidate;
                            markerNodeRef.current = markerNode;
                            break;
                        }
                    }
                    // Substring fallback: scan all markdown-ish containers for
                    // one whose textContent already contains the marker text.
                    // Accept either the new 'kohist-sel:' prefix or the legacy
                    // 'Selected:' + '⟪|⟫' pair (stale dashboard + new wrapper).
                    if (!markerNode) {
                        let containers = null;
                        try {
                            containers = doc.querySelectorAll('[data-input-id], [data-viz-id], [data-element-id]');
                        } catch (e) { /* */ }
                        if (containers) {
                            for (let i = 0; i < containers.length; i++) {
                                const tc = containers[i].textContent || '';
                                if (
                                    tc.indexOf('kohist-sel:') !== -1 ||
                                    (tc.indexOf('Selected:') !== -1 && tc.indexOf('⟪|⟫') !== -1)
                                ) {
                                    markerNode = containers[i];
                                    markerNodeRef.current = markerNode;
                                    break;
                                }
                            }
                        }
                    }
                }

                let txt = '';
                if (markerNode) {
                    // textContent never triggers layout — the key perf win.
                    txt = markerNode.textContent || '';
                } else {
                    // LAST-RESORT: full body.innerText, rate-limited to every 5th tick
                    // so steady-state cost is minimal even on DS builds where none of
                    // the targeted selectors match.
                    fallbackTickRef.current = (fallbackTickRef.current + 1) % 5;
                    if (fallbackTickRef.current !== 0) return;
                    txt = doc.body.innerText || '';
                }

                // Marker parsing lives in util/markerParse.js so this contract can
                // be tested. It could not be before, and an empty epoch field, which
                // is what EVERY first click on a KO emits, silently failed to parse:
                // the selection was dropped and the user had to click again.
                const parsed = parseMarker(txt);
                if (!parsed) return;
                const { title, appName: app, koClass, baseEpoch } = parsed;
                const key = `${title}|${app}|${koClass}|${baseEpoch || ''}`;
                if (key === lastSelRef.current) return;
                lastSelRef.current = key;
                setSel((prev) => (prev && prev.title === title && prev.appName === app && prev.koClass === koClass ? prev : { title, appName: app, koClass }));
                setSelectedEpoch(baseEpoch);
            } catch (e) {
                /* iframe not ready / transient */
            }
        };

        // CLICK-DRIVEN reads (0.1.114): instead of polling every second, read
        // the marker only after the user clicks inside the dashboard. DS sets
        // tokens (and re-renders the marker markdown) asynchronously after a
        // row click, so read a few times with increasing delay to catch it.
        const onClick = () => {
            // Clear any pending timers from the previous click before scheduling
            // a fresh batch — prevents unbounded growth in the effect-scoped array.
            timeouts.splice(0).forEach(clearTimeout);
            // Immediate feedback: a click must change something in the panel now,
            // not after the marker read resolves.
            setSelPending(true);
            [200, 600, 1400].forEach((ms) => timeouts.push(setTimeout(readMarker, ms)));
            // Self-limiting: if the click selected nothing new, no versions fetch
            // starts, so drop the pending flag rather than leaving the bar up.
            timeouts.push(setTimeout(() => setSelPending(false), 1700));
        };

        // (Re-)attach the click listener to the iframe document. The document
        // object is replaced on iframe reload, so this must be re-checked
        // periodically — the heartbeat below handles that.
        const ensureClickListener = () => {
            try {
                const doc = iframeRef.current && iframeRef.current.contentDocument;
                if (!doc || attached.doc === doc) return;
                if (attached.doc) {
                    try { attached.doc.removeEventListener('click', onClick, true); } catch (e) { /* */ }
                }
                doc.addEventListener('click', onClick, true);
                attached.doc = doc;
            } catch (e) { /* iframe not ready */ }
        };

        // Safety-net heartbeat every 5s (was a 1s poll): re-attaches the click
        // listener after iframe reloads and catches token changes that don't
        // come from a click (e.g. keyboard interaction inside the dashboard).
        ensureClickListener();
        readMarker();
        const id = setInterval(() => {
            ensureClickListener();
            readMarker();
        }, 5000);
        return () => {
            clearInterval(id);
            timeouts.forEach(clearTimeout);
            if (attached.doc) {
                try { attached.doc.removeEventListener('click', onClick, true); } catch (e) { /* */ }
            }
        };
    }, []);

    // Tear down anything that describes the PREVIOUS KO the moment the selection
    // changes.
    //
    // `compare` is a snapshot taken in doRender (slot URLs, labels, XML), but the
    // modal's Restore buttons resolve versions[idx], sel.title and sel.appName
    // from live state. The 5s marker heartbeat can change `sel` while the modal
    // is open, and the two then describe different knowledge objects: the user
    // sees dashboard X rendered and restores a version of dashboard Y. Closing
    // the modal on selection change keeps the snapshot and the live state from
    // ever disagreeing.
    React.useEffect(() => {
        setCompare(null);
        setApproval(null);
        setRunBase(false);
        setRunTarget(false);
        setHasBlended(false);
        // A restore that is mid-flight or already finished has resolved its
        // target app and name, so it is no longer at risk of following the
        // selection. Keep it up: closing it would discard the "Created X in Y"
        // confirmation the user needs. Only an unsubmitted form is dropped.
        setRestore((prev) => (prev && (prev.busy || prev.done) ? prev : null));
    }, [sel]);

    // Load versions when the selected KO changes.
    React.useEffect(() => {
        if (!sel) return undefined;
        let cancelled = false;
        const controller = new AbortController();
        // Watchdog: bound the fetch so a slow instance ends in a readable error
        // with Retry instead of a spinner that never resolves. `timedOut` keeps
        // the message honest, since an unmount/reselect abort must stay silent.
        let timedOut = false;
        const watchdog = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, VERSIONS_TIMEOUT_MS);
        // Elapsed seconds, surfaced after 5s so a slow search reads as slow.
        const startedAt = Date.now();
        setVersionsElapsed(0);
        const ticker = setInterval(() => {
            setVersionsElapsed(Math.round((Date.now() - startedAt) / 1000));
        }, 1000);
        const stopTimers = () => {
            clearTimeout(watchdog);
            clearInterval(ticker);
        };
        setLoadingVersions(true);
        setVersionsErr('');
        setVersions([]);
        // Branch on KO class: dashboards return one XML blob per version; saved
        // searches and other (generic) KOs return scattered config fields (no XML
        // to extract). The version-object shape carries `xml` for dashboards,
        // `fields` + `ss`/`gen` for the others — downstream guards on those.
        const koClass = sel.koClass;
        const isSavedC = koClass === 'savedsearch';
        const isGenericC = koClass !== 'dashboard' && koClass !== 'savedsearch';
        const spl = isSavedC
            ? versionsSplSavedSearch(sel.title, sel.appName)
            : isGenericC
                ? versionsSplGeneric(sel.title, sel.appName, sourceListForClass(koClass))
                : versionsSpl(sel.title, sel.appName);
        oneshot(spl, { signal: controller.signal })
            .then((rows) => {
                stopTimers();
                if (cancelled) return;
                let processed;
                if (isSavedC) {
                    processed = rows.map((r) => {
                        const e = extractSavedSearch(r);
                        return { _time: r.epoch, method: r.method + (r.user ? ' by ' + r.user : ''), ss: true, fields: e.fields, isConfig: e.isConfig };
                    });
                } else if (isGenericC) {
                    processed = rows.map((r) => {
                        const e = extractGeneric(r);
                        return { _time: r.epoch, method: r.method + (r.user ? ' by ' + r.user : ''), gen: true, koClass: koClass, fields: e.fields, isConfig: e.isConfig };
                    });
                } else {
                    const mapped = rows.map((r) => ({ _time: r.epoch, method: r.method + (r.user ? ' by ' + r.user : ''), xml: extractXml(r._raw) }));
                    processed = mapped.filter((r) => r.xml && r.xml.charAt(0) === '<');
                    if (processed.length === 0 && mapped.length > 0) {
                        // Rows were returned but extractXml found no renderable XML in any of them
                        // (e.g. all rows are audit-only DELETE/MOVE events with no data field).
                        setVersionsErr(`${mapped.length} event${mapped.length === 1 ? '' : 's'} found but none contain renderable source.`);
                        setLoadingVersions(false);
                        return;
                    }
                }
                // Relabel the chronologically earliest backup snapshot as "created"
                // so the version dropdown agrees with the dashboard history column.
                processed = relabelFirstCreated(processed);
                setVersions(processed);
                setLoadingVersions(false);
            })
            .catch((e) => {
                stopTimers();
                // AbortError from cancelled cleanup is intentionally swallowed here.
                if (cancelled) return;
                setVersionsErr(timedOut
                    ? `Still loading after ${Math.round(VERSIONS_TIMEOUT_MS / 1000)}s. The search may be slow on this instance.`
                    : String((e && e.message) || e));
                setLoadingVersions(false);
            });
        return () => {
            cancelled = true;
            stopTimers();
            controller.abort();
        };
    }, [sel, versionsFetchKey]);

    // The version clicked in the dashboard's "Versions of ..." table is the one
    // the user is INSPECTING, so it becomes the target (newer side) and the
    // version immediately older becomes the baseline.
    //
    // This used to be inverted here: the same click was read as the baseline and
    // compared against whatever was latest. The dashboard's own panels have
    // always treated it as the target, so one click meant opposite things in the
    // two surfaces, with neither saying which. Both now answer the same question:
    // "what did this edit change?".
    React.useEffect(() => {
        if (!versions.length) return;
        if (selectedEpoch) {
            const f = versions.findIndex((v) => sameEpoch(v._time, selectedEpoch));
            setBaselineMiss(f < 0);
            const t = f >= 0 ? f : 0;
            setTargetIdx(t);
            // versions is newest-first, so the next index is the older neighbour.
            setBaseIdx(Math.min(t + 1, versions.length - 1));
        } else {
            setBaselineMiss(false);
            setTargetIdx(0);
            setBaseIdx(versions.length > 1 ? 1 : 0);
        }
    }, [versions, selectedEpoch]);

    // Restore defaults: location = origin (the selected KO's app + view id).
    // Also reseeds the panel's own UI state (tab + open flag drawer) whenever
    // the selected KO changes — presentation-only, no data semantics here.
    React.useEffect(() => {
        setPaneTab('compare');
        setOpenFlag(null);
        if (sel) {
            setRestoreApp(sel.appName || '');
            setRestoreName(sel.title || '');
        }
    }, [sel]);
    // Restore version default = latest, reseeded whenever the version list loads.
    React.useEffect(() => {
        if (versions.length) setRestoreIdx(0);
    }, [versions]);

    // KO class drives which branch of the pane renders. isSaved = saved search;
    // isGeneric = any other non-dashboard KO (macro, + future types). isFieldsKO
    // = both — gates the XML-only machinery (heaviness, slot-compare, restore).
    // Declared here (above the name-check effect) so the effect can close over
    // them and include isSaved in its dep array without a use-before-declaration.
    const isSaved = !!(sel && sel.koClass === 'savedsearch');
    const isGeneric = !!(sel && sel.koClass !== 'dashboard' && sel.koClass !== 'savedsearch');

    // Debounced live name-availability check (~400 ms). Fires whenever restoreApp
    // or restoreName changes (or when the modal is opened). Resets the overwrite
    // opt-in whenever the target changes so a previous click never carries over.
    React.useEffect(() => {
        if (!restore || restore.done) return undefined;
        if (!restoreApp || !restoreName) {
            setRestoreNameExists(null);
            return undefined;
        }
        setRestoreNameExists(null); // show "checking…" immediately
        setRestoreOverwrite(false); // reset opt-in on every target change
        const token = { cancelled: false };
        const tid = setTimeout(() => {
            if (token.cancelled) return;
            // Generic KOs (macro, tag, …) have no single well-known REST probe
            // endpoint — leave the indicator in the neutral/unknown state rather
            // than probing the wrong endpoint (viewExists).
            if (isGeneric) {
                if (!token.cancelled) setRestoreNameExists(null);
                return;
            }
            const probe = isSaved
                ? savedSearchExists(restoreApp, restoreName)
                : viewExists(restoreApp, restoreName);
            probe.then((exists) => {
                if (!token.cancelled) setRestoreNameExists(exists);
            }).catch(() => {
                if (!token.cancelled) setRestoreNameExists(null);
            });
        }, 400);
        return () => {
            token.cancelled = true;
            clearTimeout(tid);
        };
    }, [restore, restoreApp, restoreName, isSaved, isGeneric]); // eslint-disable-line react-hooks/exhaustive-deps

    // App options for the restore target <select>: the full installed-app list,
    // guaranteeing the origin app and the current value are present (so a real
    // dropdown always shows everything, unlike a datalist which filters by text).
    const appOptions = React.useMemo(() => {
        const ids = apps.map((a) => a.id);
        const byId = {};
        apps.forEach((a) => { byId[a.id] = a.label && a.label !== a.id ? `${a.id} · ${a.label}` : a.id; });
        const extra = [];
        if (sel && sel.appName && ids.indexOf(sel.appName) < 0) extra.push(sel.appName);
        if (restoreApp && ids.indexOf(restoreApp) < 0 && extra.indexOf(restoreApp) < 0) extra.push(restoreApp);
        return extra.map((id) => ({ id, label: id })).concat(apps.map((a) => ({ id: a.id, label: byId[a.id] })));
    }, [apps, sel, restoreApp]);

    const baseVer = versions[baseIdx];
    const targetVer = versions[targetIdx];
    const restoreVer = versions[restoreIdx];
    const ready = !!(baseVer && targetVer); // same-version compare allowed (shows an empty diff)
    // True when the selected KO has exactly one captured snapshot: the two-sided
    // compare makes no sense — render a View mode instead.
    const singleVersion = versions.length === 1;
    // Saved searches can only be restored from a real config snapshot (an
    // audit-only DELETE/MOVE marker carries no SPL to write back).
    const restoreReady = !!(restoreVer && restoreApp && restoreName && (!restoreVer.ss || restoreVer.isConfig));
    // Restore is allowed only where an admin has enabled it AND a shipped
    // implementation exists. effectiveAllowed() inside isRestoreAllowed()
    // applies both, so enabling an untested type in conf changes nothing here.
    const restoreAllowed = !!(
        sel &&
        restoreSettingsState === 'ok' &&
        isRestoreAllowed(sel.koClass, restoreEnabled)
    );
    // Why not, in words, for the disabled button's tooltip. Empty when allowed.
    const restoreBlockedWhy = sel
        ? restoreBlockReason(sel.koClass, restoreEnabled, restoreSettingsState)
        : '';
    // A disabled Restore button always says why it is disabled. Policy and
    // availability come from restoreBlockReason; restoreReady is the separate
    // case of an audit-only row, which carries no source to write back.
    const restoreTip = !restoreAllowed
        ? (restoreBlockedWhy || 'Restore this version')
        : (!restoreReady
            ? 'This entry records a delete or move, so it has no captured source to restore. Choose a version captured from configuration.'
            : 'Restore this version');
    const isFieldsKO = isSaved || isGeneric;
    const latest = versions[0];
    const oldest = versions[versions.length - 1];
    const distinctCount = React.useMemo(
        () => new Set(versions.map((v) => {
            if (v.xml) return v.xml;
            const c = koContentField(v.fields);
            return c ? c.value : JSON.stringify(v.fields || {});
        })).size,
        [versions]
    );

    // Run-cost (heaviness) estimates, parsed from stored XML (no search run).
    // Dashboards only — a fields-based KO has no panel/search layout to weigh.
    const selHeavy = React.useMemo(
        () => (!isFieldsKO && (targetVer || latest) && (targetVer || latest).xml ? analyze((targetVer || latest).xml) : null),
        [isFieldsKO, targetVer, latest]
    );
    const cmpBaseHeavy = React.useMemo(() => (compare ? analyze(compare.baseXml) : null), [compare]);
    const cmpTargetHeavy = React.useMemo(() => (compare ? analyze(compare.targetXml) : null), [compare]);

    // Change lists for the live Visual overlays: which panels to box on each
    // rendered iframe. Target gets added/moved/retitled (new positions); baseline
    // gets removed/moved (old positions). idx = document order for SXML matching.
    const cmpChanges = React.useMemo(() => {
        const empty = { baseline: { changes: [], canvasW: 0, canvasH: 0 }, target: { changes: [], canvasW: 0, canvasH: 0 } };
        if (!compare) return empty;
        const b = parseSchematic(compare.baseXml);
        const t = parseSchematic(compare.targetXml);
        const d = diffSchematic(b, t);
        const tIds = {};
        t.panels.forEach((p) => { tIds[p.id] = true; });
        const target = [];
        t.panels.forEach((p, idx) => {
            const s = d.status[p.id];
            if (s && s !== 'same') target.push({ id: p.id, idx, kind: s, label: p.title, x: p.x, y: p.y, w: p.w, h: p.h });
        });
        const baseline = [];
        b.panels.forEach((p, idx) => {
            if (!tIds[p.id]) baseline.push({ id: p.id, idx, kind: 'removed', label: p.title, x: p.x, y: p.y, w: p.w, h: p.h });
            else if (d.status[p.id] === 'moved') baseline.push({ id: p.id, idx, kind: 'moved', label: p.title, x: p.x, y: p.y, w: p.w, h: p.h });
        });
        return {
            baseline: { changes: baseline, canvasW: b.canvasW, canvasH: b.canvasH },
            target: { changes: target, canvasW: t.canvasW, canvasH: t.canvasH },
        };
    }, [compare]);

    const doRender = () => {
        if (!baseVer || !targetVer) return;
        setApproval({ busy: true, error: '' });
        const cb = String(Date.now());
        // View mode writes ONE slot. The approval prompt for a single-version KO
        // promises exactly that, and writing the baseline slot too would make the
        // prompt understate what the user just approved.
        const writes = singleVersion
            ? [upsertView(SLOT_TARGET, targetVer.xml)]
            : [upsertView(SLOT_BASELINE, baseVer.xml), upsertView(SLOT_TARGET, targetVer.xml)];
        Promise.all(writes)
            .then(() => {
                setApproval(null);
                setCmpTab('visual');
                setRunBase(false);
                setRunTarget(false);
                setHasBlended(false);
                setCompare({
                    // No baseline slot is written in View mode, so there is no URL
                    // to hand out. Leaving a stale one here would render whatever
                    // the previous comparison left in that slot.
                    baseUrl: singleVersion ? null : previewUrl(SLOT_BASELINE, cb),
                    targetUrl: previewUrl(SLOT_TARGET, cb),
                    baseLabel: `${fmtTime(baseVer._time)} · ${baseVer.method || ''}`,
                    targetLabel: `${fmtTime(targetVer._time)} · ${targetVer.method || ''}`,
                    baseXml: baseVer.xml,
                    targetXml: targetVer.xml,
                });
            })
            .catch((e) => setApproval({ busy: false, error: String((e && e.message) || e) }));
    };

    // Open the restore modal for a specific version index (used from the pane
    // and from the compare toolbar). Resets the target to origin each time.
    const openRestore = (idx) => {
        if (!restoreAllowed) return;
        setRestoreIdx(idx);
        if (sel) {
            setRestoreApp(sel.appName || '');
            setRestoreName(sel.title || '');
        }
        setRestoreNameExists(null);
        setRestoreOverwrite(false);
        setRestore({ busy: false, error: '' });
    };

    const doRestore = (allowOverwrite) => {
        const ver = versions[restoreIdx];
        if (!ver || !restoreApp || !restoreName || !restoreAllowed) return;
        setRestore((s) => ({ ...(s || {}), busy: true, error: '' }));
        // Saved searches restore config via /saved/searches (owner nobody); a
        // dashboard restores its XML into data/ui/views.
        const op = ver.ss
            ? upsertSavedSearch(restoreApp, restoreName, ver.fields, !!allowOverwrite)
            : ver.xml
                ? restoreView(restoreApp, restoreName, ver.xml, !!allowOverwrite)
                : ver.gen
                    ? restoreKO(ver.koClass, restoreApp, restoreName, ver.fields, !!allowOverwrite)
                    : Promise.reject(new Error('Restore is not yet supported for this KO type.'));
        const url = ver.ss
            ? savedSearchUrl(restoreApp, restoreName)
            : ver.gen
                ? koManagerUrl(ver.koClass, restoreApp, restoreName)
                : viewUrl(restoreApp, restoreName);
        op
            .then((res) =>
                setRestore({
                    busy: false,
                    error: '',
                    done: { created: !!res.created, url: url, app: restoreApp, name: restoreName, ss: !!ver.ss, gen: !!ver.gen },
                })
            )
            .catch((e) => {
                // Belt-and-braces: if the target was created between our check and the
                // write (race), the API returns EXISTS — surface the blocked state so
                // the user can still choose to overwrite.
                if (e && e.code === 'EXISTS') {
                    setRestoreNameExists(true);
                    setRestoreOverwrite(false);
                    setRestore((s) => ({ ...(s || {}), busy: false, error: '' }));
                } else {
                    setRestore((s) => ({ ...(s || {}), busy: false, error: String((e && e.message) || e) }));
                }
            });
    };

    // ── styles ──
    const PANE_W = 380;
    const panel = {
        width: PANE_W,
        flex: `0 0 ${PANE_W}px`,
        padding: '16px 18px',
        overflow: 'auto',
        background: PAL.panel,
        border: `1px solid ${PAL.edgeSoft}`,
        borderRadius: 8,
        color: PAL.text,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: 13,
        boxSizing: 'border-box',
    };
    // Quiet Focus panel kit: shared label/control styles + button builders
    // (spec 2026-07-20-preview-compare-redesign-design.md). Every surface now
    // uses these builders; the old raw-hex `btn(bg)` helper is gone.
    const K = kitStyles();
    const lbl = K.lbl;
    const ctrl = K.ctrl;
    // Field-label variants used only inside the panel body (contract .vrow/.rrow
    // .lbl): no baked-in top margin for the first field in a section, a 12px
    // top margin to reproduce the restore pane's flex gap between later fields.
    // `lbl`/K.lbl above stays untouched — the restore-confirm modal still uses it.
    const flbl = K.fieldLbl;
    const flblGap = K.fieldLblGap;
    const btnPrimary = (enabled) => ({ ...K.btnBase,
        background: enabled ? PAL.primaryBtn : PAL.field, color: enabled ? PAL.primaryBtnText : PAL.text3,
        transition: 'background .12s, border-color .12s' });
    const btnSecondary = { ...K.btnBase, background: 'transparent', color: PAL.text, borderColor: PAL.edge,
        transition: 'background .12s, border-color .12s' };
    // K.btnBase hardcodes cursor:pointer, and the old disabled state was just a
    // flat dark box with grey text. That reads as an ordinary button, so a
    // Restore that was off by policy looked like one that simply did nothing
    // when clicked. Disabled now says so: muted outline, reduced opacity, and a
    // not-allowed cursor. The reason itself is in the title tooltip.
    const btnRestore = (enabled) => ({ ...K.btnBase,
        background: enabled ? PAL.restoreBg : PAL.field, color: enabled ? PAL.restoreText : PAL.text3,
        borderColor: enabled ? PAL.restoreBorder : PAL.edgeSoft,
        opacity: enabled ? 1 : 0.5,
        cursor: enabled ? 'pointer' : 'not-allowed',
        transition: 'background .12s, border-color .12s, opacity .12s' });
    // Destructive confirm (restore-over-existing). Deliberately distinct from
    // btnRestore's amber: overwrite is the only irreversible action here, so it
    // reads in the danger hue rather than borrowing the normal restore look.
    const btnDanger = (enabled) => ({ ...K.btnBase,
        background: enabled ? PAL.dangerBg : PAL.field, color: enabled ? PAL.danger : PAL.text3,
        borderColor: enabled ? PAL.danger : 'transparent', transition: 'background .12s, border-color .12s' });
    const btnGhost = { background: 'transparent', border: 'none', color: PAL.text2, cursor: 'pointer',
        fontSize: 13, fontWeight: 500, padding: '6px 10px', fontFamily: 'inherit',
        transition: 'background .12s, border-color .12s' };
    // ⇅ swap control (contract `.swap button`) — smaller/tighter than btnGhost,
    // resting text-3, hover lifts to text-2 with a quiet panel-2 background.
    const btnSwap = { background: swapHover ? PAL.panel2 : 'transparent', border: 'none',
        color: swapHover ? PAL.text2 : PAL.text3, cursor: 'pointer', fontSize: 11, fontWeight: 400,
        padding: '2px 10px', borderRadius: 4, fontFamily: 'inherit', display: 'inline-flex',
        gap: 5, alignItems: 'center', transition: 'background .12s, color .12s' };
    const tag = (xml) => (xml ? (isDsXml(xml) ? 'Dashboard Studio' : 'Simple XML') : '–');
    const optLabel = (v, i) => `#${i + 1} · ${fmtTime(v._time)} · ${v.method || '–'}${i === 0 ? ' · latest' : ''}`;
    // Approval modal's slot data rows (spec §A) — same slots/versions the
    // previous <li> markup rendered, just reshaped for the hairline-row idiom.
    const approvalSlots = singleVersion
        ? [{ name: SLOT_TARGET, role: '', when: targetVer ? fmtTime(targetVer._time) : '' }]
        : [
            { name: SLOT_BASELINE, role: 'older', when: baseVer ? fmtTime(baseVer._time) : '' },
            { name: SLOT_TARGET, role: 'newer', when: targetVer ? fmtTime(targetVer._time) : '' },
        ];

    return (
        <SplunkThemeProvider family="prisma" colorScheme="dark" density="comfortable">
            <div style={{ display: 'flex', height: 'calc(100vh - 56px)', minHeight: 400,
                /* The reopen tab is positioned at right:0 of the left column, so
                   if this root is ever wider than its parent the tab lands off
                   screen. The modern nav puts us in a flex row beside the
                   sidebar, where an unconstrained width does exactly that. */
                width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflowX: 'hidden',
                background: '#171d21', fontFamily: SANS }}>
                {/* Left: ko_version_ds dashboard, fills available width */}
                <div style={{ flex: '1 1 auto', minWidth: 0, position: 'relative', background: '#171d21' }}>
                    <iframe
                        ref={iframeRef}
                        title="ko_version_ds"
                        src={dashUrl}
                        style={{ width: '100%', height: '100%', border: 0, background: '#171d21', display: 'block' }}
                    />
                    {/* Reopen handle — a vertical tab on the right edge, clear of the DS toolbar */}
                    {!paneOpen ? (
                        <HoverBtn
                            onClick={() => setPaneOpen(true)}
                            title="Open the preview and compare pane"
                            base={{
                                position: 'absolute',
                                top: '50%',
                                right: 0,
                                transform: 'translateY(-50%)',
                                /* Was a raw #1a73e8, which is a full-saturation blue
                                   from another palette entirely and read as the
                                   loudest thing on a deliberately quiet page. These
                                   are the same tokens every other primary button in
                                   the wrapper uses. */
                                background: PAL.primaryBtn,
                                color: PAL.primaryBtnText,
                                border: `1px solid ${PAL.edge}`,
                                borderRight: 'none',
                                borderRadius: '6px 0 0 6px',
                                padding: '16px 7px',
                                cursor: 'pointer',
                                writingMode: 'vertical-rl',
                                fontSize: 12,
                                letterSpacing: 0.5,
                                fontFamily: 'inherit',
                                zIndex: 5,
                                boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
                                transition: 'background .12s',
                            }}
                            hover={{ background: PAL.primaryBtnHover }}
                        >
                            ‹ Preview &amp; Compare
                        </HoverBtn>
                    ) : null}
                </div>

                {/* Right: preview/compare pane (collapsible) */}
                {paneOpen ? (
                    <div style={panel}>
                        {/* Header row: title takes remaining space; Hide button is shrink:0 so it
                            can never overlap the title at any pane width. */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em' }}>Preview &amp; Compare</h3>
                            </div>
                            <HoverBtn base={{ ...btnGhost, flexShrink: 0 }} hover={{ color: PAL.text }} onClick={() => setPaneOpen(false)} title="Hide pane">
                                Hide ›
                            </HoverBtn>
                        </div>
                        <ProgressBar active={loadingVersions || selPending} />

                        {!sel ? (
                            <div style={{ color: PAL.text2, marginTop: 12 }}>Click a KO row in the dashboard…</div>
                        ) : (
                            <div>
                                {/* KO identity card (spec §7): name / format·app / Open + flags,
                                    with the heavy-run and showing-latest warnings as expandable
                                    flag drawers (spec §8) instead of full-width colored boxes. */}
                                <div style={K.koCard}>
                                    <div style={{ padding: '12px 14px' }}>
                                        <div style={{ ...K.mono, fontSize: 13, fontWeight: 500, wordBreak: 'break-all' }}>{sel.title}</div>
                                        <div style={{ marginTop: 5, fontSize: 11.5, color: PAL.text2 }}>
                                            {targetVer ? (isSaved ? prettySsType(targetVer.fields) : isGeneric ? prettyKoType(targetVer.fields) : tag(targetVer.xml)) : '–'} · {sel.appName}
                                        </div>
                                        <div style={{ display: 'flex', gap: 16, flexWrap: 'nowrap', marginTop: 7, fontSize: 11.5, alignItems: 'center', whiteSpace: 'nowrap' }}>
                                            {sel.koClass === 'dashboard' ? (
                                                <a href={viewUrl(sel.appName, sel.title)} target="_blank" rel="noopener noreferrer" title="Open the live dashboard in a new tab"
                                                   style={{ color: PAL.accentHi, textDecoration: 'none', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                                    <OpenIcon />Open
                                                </a>
                                            ) : null}
                                            {selHeavy ? (
                                                /* Level-tinted (spec: red is reserved for heavy runs —
                                                   light/moderate no longer borrow the danger hue). */
                                                <Flag
                                                    color={selHeavy.level === 'heavy' ? PAL.danger : selHeavy.level === 'moderate' ? PAL.warn : PAL.text2}
                                                    bg={selHeavy.level === 'heavy' ? PAL.dangerBg : selHeavy.level === 'moderate' ? PAL.warnBg : PAL.panel2}
                                                    dot open={openFlag === 'cost'}
                                                    onClick={() => setOpenFlag(openFlag === 'cost' ? null : 'cost')}>
                                                    {selHeavy.level === 'heavy' ? 'heavy run' : selHeavy.level + ' run'}
                                                </Flag>
                                            ) : null}
                                            {baselineMiss ? (
                                                <Flag color={PAL.warn} bg={PAL.warnBg} open={openFlag === 'render'}
                                                      onClick={() => setOpenFlag(openFlag === 'render' ? null : 'render')}>
                                                    ⚠ showing latest
                                                </Flag>
                                            ) : null}
                                        </div>
                                    </div>
                                    <Drawer open={openFlag === 'cost' && !!selHeavy}>
                                        <DrawerLead tone={selHeavy && selHeavy.level === 'heavy' ? 'danger' : 'warn'}>Run cost: {selHeavy && selHeavy.level}.</DrawerLead>{' '}
                                        {selHeavy ? `${selHeavy.panels} panels · ${selHeavy.searches} searches · ${selHeavy.range.label}. ` : ''}
                                        {selHeavy && selHeavy.note ? selHeavy.note : 'Rendering this preview dispatches those searches.'}
                                    </Drawer>
                                    <Drawer open={openFlag === 'render' && baselineMiss}>
                                        <DrawerLead tone="warn">Snapshot isn&apos;t renderable.</DrawerLead>{' '}
                                        It may be an audit-only delete/move event, or older than the 200 most recent versions.
                                        Showing the latest versions instead. <DrawerLead tone="warn">Verify the older version before restoring.</DrawerLead>
                                    </Drawer>
                                </div>

                                {loadingVersions ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: PAL.text2, margin: '10px 0 0' }}>
                                        <Spinner />
                                        Loading versions
                                        {versionsElapsed >= ELAPSED_AFTER_S ? (
                                            <span style={{ color: PAL.text3, fontVariantNumeric: 'tabular-nums' }}>, {versionsElapsed}s</span>
                                        ) : null}
                                    </div>
                                ) : null}
                                {versionsErr ? (
                                    <div style={{ color: PAL.danger, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                                        <span>Versions error: {versionsErr}</span>
                                        <HoverBtn
                                            base={{ ...btnSecondary, width: 'auto', padding: '3px 10px', fontSize: 12 }}
                                            hover={{ borderColor: PAL.text3 }}
                                            onClick={() => { lastSelRef.current = null; setVersionsFetchKey((k) => k + 1); }}
                                        >
                                            Retry
                                        </HoverBtn>
                                    </div>
                                ) : null}

                                {versions.length ? (
                                    <div>
                                        <Tabs
                                            tabs={[{ key: 'compare', label: singleVersion ? 'View' : 'Compare' }, { key: 'restore', label: 'Restore' }]}
                                            active={paneTab}
                                            onSelect={setPaneTab}
                                        />
                                        <div style={{ marginTop: 16 }}>
                                            {/* The Restore pane is entirely about restoring, so a
                                                greyed-out button with a tooltip is not enough here:
                                                say why in the pane itself, above the form. */}
                                            {paneTab === 'restore' && !restoreAllowed && restoreBlockedWhy ? (
                                                <div style={{ marginBottom: 14 }}>
                                                    <Notice warn inline>{restoreBlockedWhy}</Notice>
                                                </div>
                                            ) : null}
                                            {paneTab === 'compare' ? (
                                                <React.Fragment>
                                                    {singleVersion ? (
                                                        <div style={{ marginBottom: 10, fontSize: 12, color: PAL.text2, fontStyle: 'italic' }}>
                                                            Only one captured version. Showing it directly.
                                                        </div>
                                                    ) : null}

                                                    {!singleVersion ? (
                                                        <React.Fragment>
                                                            <label style={flbl}>Newer version</label>
                                                            <FocusCtrl as="select" style={ctrl} value={targetIdx} onChange={(e) => setTargetIdx(Number(e.target.value))}>
                                                                {versions.map((v, i) => (
                                                                    <option key={i} value={i}>{optLabel(v, i)}</option>
                                                                ))}
                                                            </FocusCtrl>

                                                            <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0' }}>
                                                                <button type="button" title="Swap newer and older" style={btnSwap}
                                                                    onMouseEnter={() => setSwapHover(true)} onMouseLeave={() => setSwapHover(false)}
                                                                    onClick={() => { const t = targetIdx; setTargetIdx(baseIdx); setBaseIdx(t); }}>
                                                                    ⇅ swap
                                                                </button>
                                                            </div>

                                                            <label style={flbl}>Older version</label>
                                                            <FocusCtrl as="select" style={ctrl} value={baseIdx} onChange={(e) => setBaseIdx(Number(e.target.value))}>
                                                                {versions.map((v, i) => (
                                                                    <option key={i} value={i}>{optLabel(v, i)}</option>
                                                                ))}
                                                            </FocusCtrl>
                                                        </React.Fragment>
                                                    ) : null}

                                                    {isSaved ? (
                                                        /* Saved searches: compare two versions (cards + field/SPL diff,
                                                           #8) and a read-only summary of the target. Restore is #9. */
                                                        <React.Fragment>
                                                            {!singleVersion ? (
                                                                <div style={{ marginTop: 14 }}>
                                                                    <HoverBtn base={btnPrimary(ready)} hover={{ background: PAL.primaryBtnHover }} disabled={!ready} onClick={() => ready && setSsCompare(true)}>
                                                                        Compare
                                                                    </HoverBtn>
                                                                    {baseIdx === targetIdx ? (
                                                                        <div style={{ color: PAL.text3, marginTop: 6, fontSize: 11 }}>Both sides are the same version. The diff will show no changes.</div>
                                                                    ) : null}
                                                                </div>
                                                            ) : null}
                                                            <SavedSearchSummary ver={targetVer} />
                                                        </React.Fragment>
                                                    ) : isGeneric ? (
                                                        /* Generic non-dashboard KOs (macros + future types): compare two
                                                           versions (cards + field/content diff) and a read-only summary.
                                                           Restore for these types is a follow-up. */
                                                        <React.Fragment>
                                                            {!singleVersion ? (
                                                                <div style={{ marginTop: 14 }}>
                                                                    <HoverBtn base={btnPrimary(ready)} hover={{ background: PAL.primaryBtnHover }} disabled={!ready} onClick={() => ready && setSsCompare(true)}>
                                                                        Compare
                                                                    </HoverBtn>
                                                                    {baseIdx === targetIdx ? (
                                                                        <div style={{ color: PAL.text3, marginTop: 6, fontSize: 11 }}>Both sides are the same version. The diff will show no changes.</div>
                                                                    ) : null}
                                                                </div>
                                                            ) : null}
                                                            <GenericSummary ver={targetVer} />
                                                        </React.Fragment>
                                                    ) : (
                                                        /* Dashboards: comparing/viewing writes into the scratch preview
                                                           slot(s) (spec §9) — a quiet one-line notice replaces the old
                                                           full-width amber boxes. */
                                                        <React.Fragment>
                                                            {!singleVersion ? (
                                                                <React.Fragment>
                                                                    <Notice>Comparing writes two scratch previews (<code style={{ ...K.mono, fontSize: 11.5 }}>kohist_cmp_*</code>) only. Your real KOs are never touched.</Notice>
                                                                    <div style={{ marginTop: 14 }}>
                                                                        <HoverBtn base={btnPrimary(ready)} hover={{ background: PAL.primaryBtnHover }} disabled={!ready} onClick={() => ready && setApproval({ busy: false, error: '' })}>
                                                                            Compare
                                                                        </HoverBtn>
                                                                        {baseIdx === targetIdx ? (
                                                                            <div style={{ color: PAL.text3, marginTop: 6, fontSize: 11 }}>Both sides are the same version. The diff will show no changes.</div>
                                                                        ) : null}
                                                                    </div>
                                                                </React.Fragment>
                                                            ) : (
                                                                /* Single-version view mode: preview + source only */
                                                                <React.Fragment>
                                                                    <Notice>Viewing writes the snapshot into a scratch preview (<code style={{ ...K.mono, fontSize: 11.5 }}>kohist_cmp_*</code>) only. Your real dashboards are never touched.</Notice>
                                                                    <div style={{ marginTop: 14 }}>
                                                                        <HoverBtn base={btnPrimary(true)} hover={{ background: PAL.primaryBtnHover }} onClick={() => setApproval({ busy: false, error: '' })}>
                                                                            View ›
                                                                        </HoverBtn>
                                                                    </div>
                                                                </React.Fragment>
                                                            )}
                                                        </React.Fragment>
                                                    )}
                                                </React.Fragment>
                                            ) : isSaved ? (
                                                /* ── Restore a saved-search version (config only; owner nobody) ── */
                                                <React.Fragment>
                                                    <label style={flbl}>Version to restore</label>
                                                    <FocusCtrl as="select" style={ctrl} value={restoreIdx} onChange={(e) => setRestoreIdx(Number(e.target.value))}>
                                                        {versions.map((v, i) => (
                                                            <option key={i} value={i} disabled={!v.isConfig}>{optLabel(v, i)}{v.isConfig ? '' : ' · (no config)'}</option>
                                                        ))}
                                                    </FocusCtrl>

                                                    <label style={flblGap}>Target app <span style={K.lblSub}>default: origin</span></label>
                                                    <FocusCtrl as="select" style={ctrl} value={restoreApp} onChange={(e) => setRestoreApp(e.target.value)}>
                                                        {appOptions.map((a) => (
                                                            <option key={a.id} value={a.id}>{a.label}{a.id === (sel && sel.appName) ? ' (origin)' : ''}</option>
                                                        ))}
                                                    </FocusCtrl>

                                                    <label style={flblGap}>Search name</label>
                                                    <FocusCtrl as="input" style={ctrl} value={restoreName} onChange={(e) => setRestoreName(e.target.value)} placeholder={sel.title} spellCheck={false} />

                                                    <div style={{ marginTop: 14 }}>
                                                        <HoverBtn base={btnRestore(restoreReady && restoreAllowed)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!(restoreReady && restoreAllowed)} title={restoreTip} onClick={() => restoreReady && restoreAllowed && setRestore({ busy: false, error: '' })}>
                                                            ⟲ Restore this version…
                                                        </HoverBtn>
                                                        <div style={{ marginTop: 6, fontSize: 11.5, color: PAL.text3 }}>
                                                            Writes config only · owner <b style={{ color: PAL.text2 }}>nobody</b> (app-shared) · sharing/owner not restored.
                                                        </div>
                                                    </div>
                                                </React.Fragment>
                                            ) : isGeneric ? (
                                                <div style={{ fontSize: 11.5, color: PAL.text3, lineHeight: 1.5 }}>
                                                    {/* The notice above already says restore has not
                                                        shipped for this type; this adds what DOES work
                                                        rather than repeating it. */}
                                                    Version history, inspect and compare are live for {prettyKoType(targetVer && targetVer.fields).toLowerCase()}s.
                                                </div>
                                            ) : (
                                                /* ── Restore: recover a captured version into a real dashboard ── */
                                                <React.Fragment>
                                                    <label style={flbl}>Version to restore</label>
                                                    <FocusCtrl as="select" style={ctrl} value={restoreIdx} onChange={(e) => setRestoreIdx(Number(e.target.value))}>
                                                        {versions.map((v, i) => (
                                                            <option key={i} value={i}>{optLabel(v, i)}</option>
                                                        ))}
                                                    </FocusCtrl>

                                                    <label style={flblGap}>Target app <span style={K.lblSub}>default: origin</span></label>
                                                    <FocusCtrl as="select" style={ctrl} value={restoreApp} onChange={(e) => setRestoreApp(e.target.value)}>
                                                        {appOptions.map((a) => (
                                                            <option key={a.id} value={a.id}>{a.label}{a.id === (sel && sel.appName) ? ' (origin)' : ''}</option>
                                                        ))}
                                                    </FocusCtrl>

                                                    <label style={flblGap}>Dashboard name <span style={K.lblSub}>view id</span></label>
                                                    <FocusCtrl as="input" style={{ ...ctrl, ...K.mono, fontSize: 12.5 }} value={restoreName} onChange={(e) => setRestoreName(e.target.value)} placeholder={sel.title} spellCheck={false} />

                                                    <div style={{ marginTop: 14 }}>
                                                        <HoverBtn base={btnRestore(restoreReady && restoreAllowed)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!(restoreReady && restoreAllowed)} title={restoreTip} onClick={() => restoreReady && restoreAllowed && setRestore({ busy: false, error: '' })}>
                                                            ⟲ Restore this version…
                                                        </HoverBtn>
                                                        <div style={{ marginTop: 10, fontSize: 11.5, color: PAL.text3, lineHeight: 1.5 }}>
                                                            <b style={{ color: PAL.text2 }}>Nothing is written yet.</b> You&apos;ll see a summary (version, app, name)
                                                            and confirm before the restore call is made. The object is live the moment it returns.
                                                        </div>
                                                    </div>
                                                </React.Fragment>
                                            )}
                                        </div>

                                        <div style={{ marginTop: 18, borderTop: `1px solid ${PAL.edgeSoft}` }}>
                                            <div style={{ ...K.lbl, margin: '14px 0 4px' }}>This KO</div>
                                            <StatsList rows={[
                                                ['Last edited', latest ? relTime(latest._time) : '–'],
                                                ['Versions tracked', `${versions.length}${distinctCount !== versions.length ? ` · ${distinctCount} distinct` : ''}`],
                                                ['First captured', oldest ? fmtTime(oldest._time) : '–'],
                                                ['Tracked span', latest && oldest ? durStr(latest._time - oldest._time) : '–'],
                                                ['Previous ⇄ latest gap', baseVer && targetVer ? durStr(Math.abs(targetVer._time - baseVer._time)) : '–'],
                                                isFieldsKO
                                                    ? ['Latest content size', (() => { const c = latest && koContentField(latest.fields); return c ? `${(c.value.length / 1024).toFixed(1)} KB` : '–'; })()]
                                                    : ['Latest size', latest && latest.xml ? `${Math.round(latest.xml.length / 1024)} KB` : '–'],
                                                isFieldsKO
                                                    ? ['Type', latest ? (isSaved ? prettySsType(latest.fields) : prettyKoType(latest.fields)) : '–']
                                                    : ['Format', latest ? (isDsXml(latest.xml) ? 'Dashboard Studio' : 'Simple XML') : '–'],
                                            ]} />
                                        </div>
                                    </div>
                                ) : !loadingVersions && !versionsErr ? (
                                    <div style={{ color: PAL.text2 }}>No renderable snapshots for this KO.</div>
                                ) : null}
                            </div>
                        )}
                    </div>
                ) : null}
            </div>

            {approval ? (
                <Modal title={singleVersion ? 'Write preview slot & render?' : 'Overwrite preview dashboards & render?'} onClose={approval.busy ? null : () => setApproval(null)}>
                    <div style={{ padding: '16px 18px 18px', color: PAL.text, fontSize: 13, lineHeight: 1.6, overflow: 'auto' }}>
                        {singleVersion ? (
                            <Notice warn>
                                This writes the snapshot into the scratch preview slot <code style={{ ...K.mono, fontSize: 11.5 }}>{SLOT_TARGET}</code> in <code style={{ ...K.mono, fontSize: 11.5 }}>{PREVIEW_APP}</code>,
                                then renders it. This slot exists only for previewing. <b>Your real dashboards are never touched.</b>
                            </Notice>
                        ) : (
                            <Notice warn>
                                This <b>overwrites</b> two scratch preview views in <code style={{ ...K.mono, fontSize: 11.5 }}>{PREVIEW_APP}</code> with
                                the selected versions, then renders them. These slots exist only for previewing. <b>Your real dashboards are never touched.</b>
                            </Notice>
                        )}
                        <div style={{ marginTop: 14, borderTop: `1px solid ${PAL.edgeSoft}` }}>
                            {approvalSlots.map(({ name, role, when }) => (
                                <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16,
                                    padding: '8px 0', borderBottom: `1px solid ${PAL.edgeSoft}`, fontSize: 12.5 }}>
                                    <span>
                                        <span style={{ ...K.mono, fontSize: 12, color: PAL.text }}>{name}</span>
                                        {role ? <span style={{ color: PAL.text3, fontSize: 11.5 }}> · {role}</span> : null}
                                    </span>
                                    <span style={{ ...K.mono, fontSize: 12, color: PAL.text2, fontVariantNumeric: 'tabular-nums' }}>{when}</span>
                                </div>
                            ))}
                        </div>
                        {/* Say it up front rather than after the user commits.
                            Writing the slots needs [views] write in this app,
                            which is admin and sc_admin by design. */}
                        {canPreview === false ? (
                            <Notice warn>
                                Preview and compare write scratch views into the {PREVIEW_APP} app, and your
                                account cannot write there. Ask a Splunk admin for write access to {PREVIEW_APP},
                                or keep using the source and diff views, which need no write access.
                            </Notice>
                        ) : null}
                        {approval.error ? <div style={{ color: PAL.danger, marginTop: 8 }}>{approval.error}</div> : null}
                        <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
                            <HoverBtn base={{ ...btnPrimary(canPreview !== false), width: 'auto' }} hover={{ background: PAL.primaryBtnHover }}
                                disabled={approval.busy || canPreview === false}
                                title={canPreview === false ? 'Your account cannot write preview views in the ' + PREVIEW_APP + ' app.' : undefined}
                                onClick={() => canPreview !== false && doRender()}>
                                {approval.busy ? <><Spinner size={12} color={PAL.primaryBtnText} /> Rendering…</> : 'Approve & render'}
                            </HoverBtn>
                            <HoverBtn base={{ ...btnSecondary, width: 'auto' }} hover={{ borderColor: PAL.text3 }} disabled={approval.busy} onClick={() => setApproval(null)}>
                                Cancel
                            </HoverBtn>
                        </div>
                    </div>
                </Modal>
            ) : null}

            {restore ? (
                <Modal
                    title={isSaved ? 'Restore saved search' : isGeneric ? `Restore ${(sel && sel.koClass) || 'object'}` : 'Restore dashboard'}
                    zIndex={MODAL_Z_ELEVATED}
                    onClose={restore.busy ? null : () => setRestore(null)}
                >
                    <div style={{ padding: '16px 18px 18px', color: PAL.text, fontSize: 13, lineHeight: 1.6, overflow: 'auto' }}>
                        {restore.done ? (
                            <div>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: PAL.diffAddedBg,
                                    border: `1px solid ${PAL.diffAdded}`, borderRadius: 6, padding: '10px 12px',
                                    marginBottom: 16, fontSize: 12.5, lineHeight: 1.5 }}>
                                    <span aria-hidden="true" style={{ flex: '0 0 auto', color: PAL.diffAdded }}>✓</span>
                                    <span>
                                        {restore.done.created ? 'Created' : 'Overwrote'}{' '}
                                        <code style={{ ...K.mono, fontSize: 12 }}>{restore.done.name}</code> in app{' '}
                                        <code style={{ ...K.mono, fontSize: 12 }}>{restore.done.app}</code>
                                        {restore.done.ss ? <span style={{ color: PAL.text2 }}> · owner <b>nobody</b> (app-shared)</span> : null}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                                    <a href={restore.done.url} target="_blank" rel="noopener noreferrer"
                                       style={{ color: PAL.accentHi, textDecoration: 'none', fontWeight: 500, fontSize: 12.5,
                                           display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                        <OpenIcon />{restore.done.ss ? 'Open saved search' : restore.done.gen ? 'Open in Settings' : 'Open dashboard'}
                                    </a>
                                    <HoverBtn base={{ ...btnSecondary, width: 'auto', marginLeft: 'auto' }} hover={{ borderColor: PAL.text3 }} onClick={() => setRestore(null)}>
                                        Done
                                    </HoverBtn>
                                </div>
                            </div>
                        ) : (
                            <div style={{ maxWidth: 560 }}>
                                {/* Version being restored, read as data: the values a user must
                                    trust (timestamp, origin object) are mono and aligned. */}
                                <div style={{ background: PAL.panel2, borderRadius: 6, padding: '10px 12px', fontSize: 12.5 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                                        <span style={{ color: PAL.text3 }}>Version to restore</span>
                                        <span style={{ ...K.mono, color: PAL.text, fontVariantNumeric: 'tabular-nums' }}>
                                            {restoreVer ? fmtTime(restoreVer._time) : ''}
                                        </span>
                                    </div>
                                    {restoreVer ? (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 5 }}>
                                            <span style={{ color: PAL.text3 }}>Captured as</span>
                                            <span style={{ color: PAL.text2 }}>
                                                {restoreVer.method || '–'} · {isSaved ? prettySsType(restoreVer.fields) : isGeneric ? prettyKoType(restoreVer.fields) : tag(restoreVer.xml)}
                                            </span>
                                        </div>
                                    ) : null}
                                    {sel ? (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginTop: 5 }}>
                                            <span style={{ color: PAL.text3 }}>Origin</span>
                                            <span style={{ ...K.mono, color: PAL.text2, wordBreak: 'break-all', textAlign: 'right' }}>
                                                {sel.title} ({sel.appName})
                                            </span>
                                        </div>
                                    ) : null}
                                </div>

                                <label style={lbl}>Target app <span style={K.lblSub}>(default: origin)</span></label>
                                {appsLoadErr ? (
                                    <Notice inline>Could not load the app list. You can still type an app name below.</Notice>
                                ) : null}
                                <FocusCtrl as="select" style={ctrl} value={restoreApp} onChange={(e) => { setRestoreApp(e.target.value); }}>
                                    {appOptions.map((a) => (
                                        <option key={a.id} value={a.id}>{a.label}{a.id === (sel && sel.appName) ? ' (origin)' : ''}</option>
                                    ))}
                                </FocusCtrl>

                                <label style={lbl}>{isSaved ? 'Search name' : isGeneric ? 'Object name' : <span>Dashboard name <span style={K.lblSub}>(view id)</span></span>}</label>
                                <FocusCtrl as="input" style={ctrl} value={restoreName} onChange={(e) => { setRestoreName(e.target.value); }} spellCheck={false} />

                                {/* Live name-availability indicator */}
                                {restoreApp && restoreName ? (
                                    restoreNameExists === null ? (
                                        <div style={{ marginTop: 6, fontSize: 11.5, color: PAL.text3, display: 'flex', alignItems: 'center', gap: 5 }}><Spinner size={11} /> Checking</div>
                                    ) : restoreNameExists ? (
                                        <div style={{ marginTop: 6, fontSize: 11.5, color: PAL.warn, display: 'flex', alignItems: 'center', gap: 5 }}>
                                            <span aria-hidden="true">⚠</span>
                                            <span><code style={{ ...K.mono, fontSize: 11.5 }}>{restoreName}</code> already exists in app <code style={{ ...K.mono, fontSize: 11.5 }}>{restoreApp}</code></span>
                                        </div>
                                    ) : (
                                        <div style={{ marginTop: 6, fontSize: 11.5, color: PAL.text2, display: 'flex', alignItems: 'center', gap: 5 }}>
                                            <span aria-hidden="true" style={{ color: PAL.diffAdded }}>✓</span>
                                            <span>Name available in <code style={{ ...K.mono, fontSize: 11.5 }}>{restoreApp}</code></span>
                                        </div>
                                    )
                                ) : null}

                                {isSaved ? (
                                    <Notice>
                                        Writes a <b>real saved search</b> as owner <b>nobody</b> (app-shared). Sharing and owner ACLs are <b>not</b> restored. You need write access to the target app.
                                    </Notice>
                                ) : isGeneric ? (
                                    <div>
                                        <Notice>
                                            Writes a <b>real {sel ? sel.koClass : 'object'}</b> as owner <b>nobody</b> (app-shared). Sharing and owner ACLs are <b>not</b> restored. You need write access to the target app.
                                        </Notice>
                                        {sel && sel.koClass === 'lookup' ? (
                                            <Notice warn>
                                                Restores the lookup <b>definition</b> only. The underlying .csv or KV-store <b>data is not versioned</b> and will not be restored.
                                            </Notice>
                                        ) : null}
                                        {sel && sel.koClass === 'tag' ? (
                                            <Notice warn>
                                                Re-enables the captured tags on this <code style={{ ...K.mono, fontSize: 11.5 }}>field=value</code> pair. Tags added live since the snapshot are <b>not</b> removed.
                                            </Notice>
                                        ) : null}
                                    </div>
                                ) : (
                                    <Notice>
                                        Writes a <b>real dashboard</b> into Splunk. You need write access to the target app.
                                    </Notice>
                                )}
                                {/* Checked before the user commits, not after: the
                                    target app dropdown lists every app, but write
                                    access is per app and usually admin-only. */}
                                {canWriteTarget === false ? (
                                    <Notice warn>
                                        Your account cannot create objects in the <b>{restoreApp}</b> app, so this
                                        restore would be refused. Choose an app you can write to, or ask a Splunk admin.
                                    </Notice>
                                ) : null}
                                {restore.error ? <div style={{ color: PAL.danger, marginTop: 10, fontSize: 12.5 }}>{restore.error}</div> : null}

                                {/* Two-step overwrite guard: when the target exists, block the normal
                                    confirm path and require an explicit separate "Overwrite" click. */}
                                {restoreNameExists && !restoreOverwrite ? (
                                    <div style={{ marginTop: 14 }}>
                                        {/* Genuine caution: this one stays a full box rather than a
                                            quiet Notice, because it is the only irreversible action
                                            in the wrapper. */}
                                        <div style={{ background: PAL.warnBg, border: `1px solid ${PAL.warn}`, color: PAL.warn,
                                            borderRadius: 6, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, lineHeight: 1.5,
                                            display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                            <span aria-hidden="true" style={{ flex: '0 0 auto' }}>⚠</span>
                                            <span>
                                                <code style={{ ...K.mono, fontSize: 12 }}>{restoreName}</code> already exists in <code style={{ ...K.mono, fontSize: 12 }}>{restoreApp}</code>.
                                                Restoring will permanently overwrite its current content. This cannot be undone, unless KO History has a snapshot of it too.
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', gap: 10 }}>
                                            <HoverBtn
                                                base={{ ...btnDanger(restoreReady && restoreAllowed && canWriteTarget !== false), width: 'auto' }}
                                                hover={{ background: PAL.dangerBgHover }}
                                                disabled={restore.busy || !restoreReady || !restoreAllowed || canWriteTarget === false}
                                                title={!restoreAllowed ? restoreTip : canWriteTarget === false ? 'Your account cannot write to the ' + restoreApp + ' app.' : undefined}
                                                onClick={() => restoreAllowed && canWriteTarget !== false && setRestoreOverwrite(true)}
                                            >
                                                Overwrite existing {isSaved ? 'saved search' : isGeneric ? (sel ? sel.koClass : 'object') : 'dashboard'}
                                            </HoverBtn>
                                            <HoverBtn base={{ ...btnSecondary, width: 'auto' }} hover={{ borderColor: PAL.text3 }} disabled={restore.busy} onClick={() => setRestore(null)}>
                                                Cancel
                                            </HoverBtn>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                                        <HoverBtn
                                            base={{ ...(restoreOverwrite ? btnDanger(restoreReady && restoreAllowed && canWriteTarget !== false && restoreNameExists !== null)
                                                                        : btnRestore(restoreReady && restoreAllowed && canWriteTarget !== false && restoreNameExists !== null)), width: 'auto' }}
                                            hover={restoreOverwrite ? { background: PAL.dangerBgHover } : { background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }}
                                            disabled={restore.busy || !restoreReady || !restoreAllowed || canWriteTarget === false || restoreNameExists === null}
                                            title={!restoreAllowed ? restoreTip : canWriteTarget === false ? 'Your account cannot write to the ' + restoreApp + ' app.' : undefined}
                                            onClick={() => restoreAllowed && canWriteTarget !== false && doRestore(restoreOverwrite)}
                                        >
                                            {restore.busy
                                                ? <><Spinner size={12} color={restoreOverwrite ? PAL.danger : PAL.restoreText} /> Restoring…</>
                                                : restoreOverwrite ? 'Confirm overwrite' : 'Confirm restore'}
                                        </HoverBtn>
                                        <HoverBtn base={{ ...btnSecondary, width: 'auto' }} hover={{ borderColor: PAL.text3 }} disabled={restore.busy} onClick={() => setRestore(null)}>
                                            Cancel
                                        </HoverBtn>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </Modal>
            ) : null}

            {compare ? (
                <Modal title={singleVersion ? `View: ${sel ? sel.title : ''}` : `Compare: ${sel ? sel.title : ''}`} onClose={() => setCompare(null)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}`, flexWrap: 'wrap' }}>
                        <Seg
                            items={[['visual', 'Visual'], ['source', 'Source'], ['diff', 'Source diff']].filter(([t]) => !singleVersion || t !== 'diff')}
                            active={cmpTab}
                            onSelect={setCmpTab}
                        />
                        {cmpTab !== 'visual' ? (
                            <React.Fragment>
                                <span style={{ flex: 1 }} />
                                {/* These two were hardcoded enabled. openRestore()
                                    guards on restoreAllowed and returns silently,
                                    so with restore off they looked live and did
                                    nothing when clicked. */}
                                <span style={{ color: PAL.text3, fontSize: 11.5, marginRight: 2 }}>Restore</span>
                                {!singleVersion ? (
                                    <HoverBtn base={btnRestoreSmall(restoreAllowed)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!restoreAllowed} title={restoreAllowed ? 'Restore the older version' : restoreTip} onClick={() => restoreAllowed && openRestore(baseIdx)}>
                                        ⟲ Older
                                    </HoverBtn>
                                ) : null}
                                <HoverBtn base={btnRestoreSmall(restoreAllowed)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} disabled={!restoreAllowed} title={restoreAllowed ? (singleVersion ? 'Restore this version' : 'Restore the newer version') : restoreTip} onClick={() => restoreAllowed && openRestore(targetIdx)}>
                                    {singleVersion ? '⟲ Restore this version' : '⟲ Newer'}
                                </HoverBtn>
                            </React.Fragment>
                        ) : null}
                    </div>
                    {cmpTab === 'visual' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                            {singleVersion ? (
                                /* Single-version view: one column, simple run button, no blend or diff overlay */
                                <React.Fragment>
                                    {!runTarget ? (
                                        <div style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}` }}>
                                            <HoverBtn base={btnPrimarySmall(true)} hover={{ background: PAL.primaryBtnHover }} onClick={() => setRunTarget(true)}>▶ Run</HoverBtn>
                                            <Notice inline>Rendering runs the dashboard&apos;s searches live.</Notice>
                                            <span style={{ flex: 1 }} />
                                            <CostFlag a={cmpTargetHeavy} />
                                        </div>
                                    ) : null}
                                    <CompareColumn tag="Version" label={compare.targetLabel} url={compare.targetUrl} run={runTarget} onRun={() => setRunTarget(true)} onRestore={restoreAllowed ? (() => openRestore(targetIdx)) : undefined} heavy={cmpTargetHeavy} changes={[]} canvasW={0} canvasH={0} overlays={false} kinds={kinds} />
                                </React.Fragment>
                            ) : (
                                /* Multi-version view: toolbar, two columns, blend */
                                <React.Fragment>
                                    {/* persistent overlay toggle + per-kind show/hide + summary */}
                                    {(() => {
                                        const a = cmpChanges.target.changes.filter((c) => c.kind === 'added').length;
                                        const md = cmpChanges.target.changes.filter((c) => c.kind === 'moved' || c.kind === 'retitled').length
                                            + cmpChanges.baseline.changes.filter((c) => c.kind === 'moved').length;
                                        const rm = cmpChanges.baseline.changes.filter((c) => c.kind === 'removed').length;
                                        const kindBox = (key, color, bg, label, n) => (
                                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: overlays ? 'pointer' : 'default', fontSize: 11.5, color: overlays ? PAL.text2 : PAL.text3, opacity: overlays ? 1 : 0.5 }}>
                                                <input type="checkbox" disabled={!overlays} checked={kinds[key]} onChange={(e) => setKinds((k) => ({ ...k, [key]: e.target.checked }))} style={{ accentColor: PAL.accent }} />
                                                <span style={{ width: 10, height: 10, borderRadius: 2, border: `1.5px ${key === 'removed' ? 'dashed' : 'solid'} ${color}`, background: bg, display: 'inline-block' }} />
                                                {label} ({n})
                                            </label>
                                        );
                                        return (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 12px', background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}`, flexWrap: 'wrap' }}>
                                                {/* Blend stacks two renders, so it is meaningless for a single
                                                    captured version. That case never reaches here: View mode is
                                                    handled by the singleVersion arm above, which renders no
                                                    toolbar at all. */}
                                                <Seg
                                                    items={[
                                                        ['boxes', 'Boxes', 'Draw change boxes on each render, side by side'],
                                                        ['blend', 'Blend', 'Stack both renders and blend (difference / onion-skin)'],
                                                    ]}
                                                    active={visualMode}
                                                    onSelect={(m) => { setVisualMode(m); if (m === 'blend') setHasBlended(true); }}
                                                />
                                                {visualMode === 'boxes' ? (
                                                    <React.Fragment>
                                                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12, color: PAL.text }}>
                                                            <input type="checkbox" checked={overlays} onChange={(e) => setOverlays(e.target.checked)} style={{ accentColor: PAL.accent }} />
                                                            Highlight changes
                                                        </label>
                                                        {kindBox('added', PAL.diffAdded, PAL.diffAddedBg, 'Added', a)}
                                                        {kindBox('modified', PAL.diffModified, PAL.diffModifiedBg, 'Modified', md)}
                                                        {kindBox('removed', PAL.diffRemoved, PAL.diffRemovedBg, 'Removed', rm)}
                                                        {!a && !md && !rm ? <span style={{ color: PAL.text3, fontSize: 11 }}>no structural change</span> : null}
                                                        <span style={{ flex: 1 }} />
                                                        <span style={{ fontSize: 11.5, color: PAL.text3 }}>boxes are drawn over the live render: run a side to see them</span>
                                                    </React.Fragment>
                                                ) : (
                                                    <React.Fragment>
                                                        <span style={{ flex: 1 }} />
                                                        <span style={{ fontSize: 11.5, color: PAL.text3 }}>both renders stacked &amp; blended: identical pixels cancel, changes glow</span>
                                                    </React.Fragment>
                                                )}
                                            </div>
                                        );
                                    })()}
                                    {/* Boxes pair is always visible when run flags are set. BlendView is
                                        only mounted after blend mode is first activated (hasBlended), then
                                        persisted with display:none so iframes survive mode toggles without
                                        re-running their searches. */}
                                    <div style={{ display: visualMode === 'boxes' ? 'contents' : 'none' }}>
                                        {/* Everything from here down is inside the `singleVersion ? ... : ...`
                                            ELSE arm above, so singleVersion is already false. Do not re-test
                                            it: a second branch here is unreachable, and a maintainer editing
                                            View mode would be editing dead code. */}
                                        <React.Fragment>
                                            {!runBase || !runTarget ? (
                                                <div style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}` }}>
                                                    <HoverBtn base={btnPrimarySmall(true)} hover={{ background: PAL.primaryBtnHover }} onClick={() => { setRunBase(true); setRunTarget(true); }}>▶ Run both</HoverBtn>
                                                    <Notice inline>Rendering runs each dashboard&apos;s searches live. Run both, or one side at a time.</Notice>
                                                    <span style={{ flex: 1 }} />
                                                    <CostFlag a={cmpBaseHeavy} prefix="Older" />
                                                    <CostFlag a={cmpTargetHeavy} prefix="Newer" />
                                                </div>
                                            ) : null}
                                            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                                                <CompareColumn tag="Older" label={compare.baseLabel} url={compare.baseUrl} run={runBase} onRun={() => setRunBase(true)} onRestore={restoreAllowed ? (() => openRestore(baseIdx)) : undefined} heavy={cmpBaseHeavy} changes={cmpChanges.baseline.changes} canvasW={cmpChanges.baseline.canvasW} canvasH={cmpChanges.baseline.canvasH} overlays={overlays} kinds={kinds} />
                                                <div style={{ width: 1, background: PAL.edgeSoft }} />
                                                <CompareColumn tag="Newer" label={compare.targetLabel} url={compare.targetUrl} run={runTarget} onRun={() => setRunTarget(true)} onRestore={restoreAllowed ? (() => openRestore(targetIdx)) : undefined} heavy={cmpTargetHeavy} changes={cmpChanges.target.changes} canvasW={cmpChanges.target.canvasW} canvasH={cmpChanges.target.canvasH} overlays={overlays} kinds={kinds} />
                                            </div>
                                        </React.Fragment>
                                    </div>
                                    <div style={{ display: visualMode === 'blend' ? 'contents' : 'none' }}>
                                        {(hasBlended && runBase && runTarget) ? (
                                            <BlendView baseUrl={compare.baseUrl} targetUrl={compare.targetUrl} baseLabel={compare.baseLabel} targetLabel={compare.targetLabel} />
                                        ) : (
                                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: PAL.text2, background: PAL.modalBody }}>
                                                <div style={{ display: 'flex', gap: 8 }}>
                                                    <CostFlag a={cmpBaseHeavy} prefix="Older" />
                                                    <CostFlag a={cmpTargetHeavy} prefix="Newer" />
                                                </div>
                                                <HoverBtn base={btnPrimarySmall(true)} hover={{ background: PAL.primaryBtnHover }} onClick={() => { setRunBase(true); setRunTarget(true); setHasBlended(true); }}>▶ Run both to blend</HoverBtn>
                                                <Notice>Blend stacks both live renders, so both must run.</Notice>
                                            </div>
                                        )}
                                    </div>
                                </React.Fragment>
                            )}
                        </div>
                    ) : cmpTab === 'source' ? (
                        singleVersion ? (
                            /* Single-version: one SourceView panel */
                            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                                <div style={{ padding: '7px 12px', background: PAL.field, borderBottom: `1px solid ${PAL.edgeSoft}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3, whiteSpace: 'nowrap' }}>Version</span>
                                    <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{compare.targetLabel}</span>
                                </div>
                                <div style={{ flex: 1, minHeight: 0 }}>
                                    <SourceView raw={compare.targetXml} title={sel ? sel.title : ''} app={sel ? sel.appName : ''} initialDepth={-1} />
                                </div>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 1, background: PAL.edgeSoft }}>
                                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ padding: '7px 12px', background: PAL.field, borderBottom: `1px solid ${PAL.edgeSoft}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3, whiteSpace: 'nowrap' }}>Older</span>
                                        <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{compare.baseLabel}</span>
                                    </div>
                                    <div style={{ flex: 1, minHeight: 0 }}>
                                        <SourceView raw={compare.baseXml} title={sel ? sel.title : ''} app={sel ? sel.appName : ''} initialDepth={-1} />
                                    </div>
                                </div>
                                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ padding: '7px 12px', background: PAL.field, borderBottom: `1px solid ${PAL.edgeSoft}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3, whiteSpace: 'nowrap' }}>Newer</span>
                                        <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{compare.targetLabel}</span>
                                    </div>
                                    <div style={{ flex: 1, minHeight: 0 }}>
                                        <SourceView raw={compare.targetXml} title={sel ? sel.title : ''} app={sel ? sel.appName : ''} initialDepth={-1} />
                                    </div>
                                </div>
                            </div>
                        )
                    ) : (
                        <SourceDiff a={compare.baseXml} b={compare.targetXml} />
                    )}
                </Modal>
            ) : null}

            {ssCompare && baseVer && targetVer ? (
                <SavedSearchCompare
                    title={sel ? sel.title : ''}
                    baseVer={baseVer}
                    targetVer={targetVer}
                    onClose={() => setSsCompare(false)}
                    onRestore={restoreAllowed ? ((which) => openRestore(which === 'baseline' ? baseIdx : targetIdx)) : undefined}
                />
            ) : null}

        </SplunkThemeProvider>
    );
}

function Modal({ title, onClose, children, zIndex }) {
    return (
        <div onClick={onClose || undefined} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: zIndex || MODAL_Z }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: '95vw', height: '92vh', background: PAL.modalBody, border: `1px solid ${PAL.edge}`, borderRadius: 6, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.6)', fontFamily: SANS }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}`, color: PAL.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, fontWeight: 600 }}>
                    <span>{title}</span>
                    {onClose ? (
                        <HoverBtn
                            base={{ background: 'transparent', color: PAL.text2, border: `1px solid ${PAL.edge}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, transition: 'color .12s, border-color .12s' }}
                            hover={{ color: PAL.text, borderColor: PAL.text3 }}
                            onClick={onClose}
                        >
                            ✕ Close
                        </HoverBtn>
                    ) : null}
                </div>
                {children}
            </div>
        </div>
    );
}

function CompareColumn({ tag, label, url, run, onRun, onRestore, heavy, changes, canvasW, canvasH, overlays, kinds }) {
    const ifRef = React.useRef(null);
    const shown = React.useMemo(
        () => (changes || []).filter((c) => (kinds ? kinds[KIND_GROUP[c.kind] || 'modified'] : true)),
        [changes, kinds]
    );
    const nShown = shown.length;
    const [diag, setDiag] = React.useState(null);
    // iframeLoaded: reset to false each time src changes (run becomes true or url changes),
    // set to true on onLoad — drives the spinner overlay shown while the iframe is loading.
    const [iframeLoaded, setIframeLoaded] = React.useState(false);
    React.useEffect(() => {
        if (run) setIframeLoaded(false);
    }, [run, url]);
    React.useEffect(() => {
        setDiag(null);
        if (!run || !overlays || !nShown) {
            // clear any stale boxes when overlays/kinds turn the set empty
            const el0 = ifRef.current;
            if (el0) { clearHighlights(el0); }
            return undefined;
        }
        const el = ifRef.current;
        if (!el) return undefined;
        let stop = null;
        const begin = () => { if (stop) stop(); stop = startHighlightPoll(el, shown, { canvasW, canvasH }, setDiag, HL_COLORS); };
        el.addEventListener('load', begin);
        begin(); // in case it already loaded
        return () => { el.removeEventListener('load', begin); if (stop) stop(); };
    }, [run, url, overlays, nShown, canvasW, canvasH, kinds]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '7px 12px', background: PAL.field, borderBottom: `1px solid ${PAL.edgeSoft}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: PAL.text3, whiteSpace: 'nowrap' }}>{tag}</span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: PAL.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                {overlays && nShown ? (
                    <span style={{ fontSize: 11.5, color: diag && diag.count ? PAL.text2 : PAL.warn, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {diag ? (diag.selector && diag.selector.indexOf('canvas') === 0 ? `${diag.count} boxed` : `found ${diag.found} · boxed ${diag.count}${diag.selector ? ` · [${diag.selector}]` : ''}`) : `${nShown} to box…`}
                    </span>
                ) : null}
                <span style={{ flex: 1 }} />
                {/* Dropped entirely when restore is not allowed, the same way
                    SavedSearchCompare handles it. A column header is too tight
                    for a dead control, and the Restore pane already explains
                    why. Callers pass onRestore undefined to switch it off. */}
                {onRestore ? (
                    <HoverBtn base={btnRestoreSmall(true)} hover={{ background: PAL.restoreBgHover, borderColor: PAL.restoreBorderHover }} title={`Restore this ${tag.toLowerCase()} version`} onClick={onRestore}>
                        ⟲ Restore
                    </HoverBtn>
                ) : null}
            </div>
            {run ? (
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                    {!iframeLoaded ? (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: PAL.modalBody, zIndex: 2, gap: 8, color: PAL.text2, fontSize: 13 }}>
                            <Spinner size={16} color={PAL.accent} /> Loading…
                        </div>
                    ) : null}
                    <iframe ref={ifRef} title={tag} src={url}
                        onLoad={() => setIframeLoaded(true)}
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#fff' }} />
                </div>
            ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: PAL.text3, background: PAL.modalBody, fontSize: 13 }}>
                    {heavy ? <CostFlag a={heavy} /> : null}
                    <HoverBtn base={btnPrimarySmall(true)} hover={{ background: PAL.primaryBtnHover }} onClick={onRun}>
                        ▶ Run searches
                    </HoverBtn>
                    <span>Runs only this {tag.toLowerCase()} dashboard.</span>
                </div>
            )}
        </div>
    );
}

// #44 — overlay both live renders and blend them (Photoshop "Difference" /
// onion-skin). Both preview-slot iframes are same-origin, so we can stack them
// and let mix-blend-mode composite across the iframe boundary. Identical
// dashboards cancel to black; differences glow. Onion mode crossfades instead.
// `isolation:isolate` keeps the blend backdrop = baseline render + white, not
// the dark modal behind it.
//
// Zoom (0.5–2.0): CSS transform:scale on a shared inner container holding both
// iframes, with container sized to 100/k% so scaled content fills the viewport.
// Synced scroll: both iframes are sized to the taller document's scrollHeight
// and overflow:visible; a single outer div with overflow:auto is the one scroller,
// keeping both layers pixel-locked while the user scrolls.
// Align ↕: two independent vertical offsets (prevY / latestY), one slider per
// layer — each control moves ONLY its own layer (top = its own offset, no
// cross-layer normalization). The container grows for downward shifts so the
// shared scroller still reaches them; an upward shift clips that layer's top.
function BlendView({ baseUrl, targetUrl, baseLabel, targetLabel }) {
    const [mode, setMode] = React.useState('difference'); // 'difference' | 'onion'
    const [op, setOp] = React.useState(100);
    const [zoom, setZoom] = React.useState(1);
    // Independent vertical alignment nudge per layer, in unscaled px (>0 = down).
    // prevY moves PREVIOUS, latestY moves LATEST — each control touches ONLY its
    // own layer, so it's never ambiguous which one shifted. Lets the user line up
    // a panel whose position moved between versions. The normal scrollbar stays a
    // shared camera over both layers.
    const [prevY, setPrevY] = React.useState(0);
    const [latestY, setLatestY] = React.useState(0);
    const baseRef = React.useRef(null);
    const targetRef = React.useRef(null);
    // contentH: measured max(baseline, target) scrollHeight in px (unscaled)
    const [contentH, setContentH] = React.useState(null);
    // Reset both alignment nudges whenever a new pair is compared.
    React.useEffect(() => { setPrevY(0); setLatestY(0); }, [baseUrl, targetUrl]);

    const pickMode = (m) => { setMode(m); setOp(m === 'onion' ? 50 : 100); };
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const zoomIn  = () => setZoom((z) => { const next = ZOOM_STEPS.find((s) => s > z); return next !== undefined ? next : z; });
    const zoomOut = () => setZoom((z) => { const arr = [...ZOOM_STEPS].reverse(); const next = arr.find((s) => s < z); return next !== undefined ? next : z; });

    // Measure both iframes' content height every 2 s (or on load) so we can
    // give both iframes an explicit height = max(both), letting a single outer
    // scroller move them together without internal iframe scroll bars.
    React.useEffect(() => {
        let cancelled = false;
        let prevH = null;
        let stable = 0;
        let ticks = 0;
        const MAX_TICKS = 60;
        let iv = null;
        const measure = () => {
            if (cancelled) return;
            let h = null;
            try {
                const bh = baseRef.current && baseRef.current.contentDocument
                    ? baseRef.current.contentDocument.body.scrollHeight : 0;
                const th = targetRef.current && targetRef.current.contentDocument
                    ? targetRef.current.contentDocument.body.scrollHeight : 0;
                const m = Math.max(bh || 0, th || 0);
                if (m > 0) h = m;
            } catch (e) { /* cross-origin guard — fall back to no fixed height */ }
            if (!cancelled) {
                setContentH(h);
                // Stop the poll once height is stable for 2 consecutive interval
                // ticks, or after a hard cap of ~60 ticks (mirrors highlightInject's
                // maxTries pattern). The load re-arm resets the tick counter so a
                // legitimately-still-loading dashboard gets a fresh 60-tick window.
                if (iv !== null) {
                    if (h !== null && h === prevH) { stable += 1; } else { stable = 0; }
                    if (stable >= 2 || ticks >= MAX_TICKS) { clearInterval(iv); iv = null; }
                }
                prevH = h;
            }
        };
        const tick = () => { ticks++; measure(); };
        const onLoad = () => {
            // Re-arm after each iframe load: heights will change as panels render.
            // Reset both counters so the fresh load gets a full 60-tick window.
            stable = 0;
            ticks = 0;
            if (iv === null && !cancelled) { iv = setInterval(tick, 2000); }
            measure();
        };
        const baseEl = baseRef.current;
        const tgtEl  = targetRef.current;
        if (baseEl) baseEl.addEventListener('load', onLoad);
        if (tgtEl)  tgtEl.addEventListener('load', onLoad);
        measure(); // immediate attempt if already loaded
        iv = setInterval(tick, 2000);
        return () => {
            cancelled = true;
            if (iv !== null) clearInterval(iv);
            if (baseEl) baseEl.removeEventListener('load', onLoad);
            if (tgtEl)  tgtEl.removeEventListener('load', onLoad);
        };
    }, [baseUrl, targetUrl]);

    // Pixel percentage the inner (zoom) container occupies so scaled content
    // fills the viewport rather than overflowing or leaving dead space.
    const invPct = `${(100 / zoom).toFixed(4)}%`;

    // iframes are positioned absolute inside the scaled container; their height
    // is either the measured content height (synced scroll) or 100% fallback.
    const iframeH = contentH ? `${contentH}px` : '100%';

    // Each layer sits at exactly its own offset — no normalization, so a slider
    // NEVER moves the other layer (that coupling made the wrong dashboard shift).
    // A positive offset pushes that layer down; the container grows to keep it
    // reachable. A negative offset pulls it up; its top edge clips off-screen
    // (use the other layer's positive shift for the same alignment without clip).
    const baseTop = prevY;     // PREVIOUS layer top
    const tgtTop  = latestY;    // LATEST layer top
    const growth  = Math.max(0, prevY, latestY);   // extra height for downward shifts
    // Slider travel: at least the content height so any panel can be aligned.
    const offRange = Math.max(300, contentH || 1500);

    const topStyle = {
        position: 'absolute', top: tgtTop, left: 0, width: '100%', height: iframeH, border: 0,
        background: 'transparent',
        mixBlendMode: mode === 'difference' ? 'difference' : 'normal',
        opacity: op / 100,
        // pointer-events:none on the top layer so interactions reach the baseline
        pointerEvents: 'none',
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            {/* ── toolbar ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 12px', background: PAL.panel, borderBottom: `1px solid ${PAL.edgeSoft}`, flexWrap: 'wrap' }}>
                {/* mode toggle */}
                <Seg items={[['difference', 'Difference'], ['onion', 'Onion-skin']]} active={mode} onSelect={pickMode} />
                {/* opacity/blend slider */}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: PAL.text2 }}>
                    {mode === 'onion' ? 'Older ⇄ Newer' : 'Intensity'}
                    <input type="range" min={0} max={100} value={op} onChange={(e) => setOp(Number(e.target.value))} style={{ width: 180, accentColor: PAL.accent }} />
                    <span style={{ fontFamily: MONO, fontSize: 11, color: PAL.text3, width: 34, textAlign: 'right' }}>{op}%</span>
                </label>
                {/* zoom controls */}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <HoverBtn base={ghostSmall(false)} hover={{ color: PAL.text, borderColor: PAL.text3 }} title="Zoom out" onClick={zoomOut} disabled={zoom <= ZOOM_STEPS[0]}>−</HoverBtn>
                    <HoverBtn base={ghostSmall(zoom !== 1)} hover={{ color: PAL.text, borderColor: PAL.text3 }} title="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</HoverBtn>
                    <HoverBtn base={ghostSmall(false)} hover={{ color: PAL.text, borderColor: PAL.text3 }} title="Zoom in" onClick={zoomIn} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>+</HoverBtn>
                </div>
                {/* per-layer vertical alignment nudges — each slider moves ONLY
                    its own layer, so a panel that moved between versions can be
                    lined up without ambiguity. Quiet/neutral text — the arrows
                    (▼/▲) plus label carry the distinction, not color. */}
                {[
                    ['▼ Older', prevY, setPrevY],
                    ['▲ Newer', latestY, setLatestY],
                ].map(([lbl, val, set]) => (
                    <label key={lbl} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: PAL.text2 }}
                        title={'Shift ' + lbl.slice(2) + ' up/down to align it with the other version'}>
                        {lbl}&nbsp;↕
                        <input type="range" min={-offRange} max={offRange} step={5} value={val}
                            onChange={(e) => set(Number(e.target.value))} style={{ width: 120, accentColor: PAL.accent }} />
                        <span style={{ fontFamily: MONO, fontSize: 11, color: PAL.text3, width: 50, textAlign: 'right' }}>{val > 0 ? '+' : ''}{val}px</span>
                        <HoverBtn base={ghostSmall(val !== 0)} hover={{ color: PAL.text, borderColor: PAL.text3 }} title={'Reset ' + lbl.slice(2)} onClick={() => set(0)} disabled={val === 0}>↺</HoverBtn>
                    </label>
                ))}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: PAL.text3 }}>
                    {mode === 'difference' ? 'identical pixels → black · changes glow in colour' : 'slide to fade between the two versions'}
                </span>
            </div>
            {/* ── viewport: single scroller wrapping the scaled layer container ── */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fff' }}>
                {/* scaled container: sized to invPct so CSS-scaled content fills the
                    viewport; both iframes live here and inherit the same scroll position
                    from the single outer scroller above. */}
                <div style={{
                    width: invPct,
                    height: contentH ? `${contentH + growth}px` : invPct,
                    transform: `scale(${zoom})`,
                    transformOrigin: 'top left',
                    position: 'relative',
                    isolation: 'isolate',
                    background: '#fff',
                }}>
                    {/* baseline — bottom layer, fully interactive */}
                    <iframe ref={baseRef} title="blend-baseline" src={baseUrl}
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        style={{ position: 'absolute', top: baseTop, left: 0, width: '100%', height: iframeH, border: 0, background: '#fff', overflow: 'hidden' }} />
                    {/* target — top layer, pointer-events:none so clicks reach baseline */}
                    <iframe ref={targetRef} title="blend-target" src={targetUrl}
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        style={topStyle} />
                    {/* version labels — pinned inside the scaled container */}
                    <div style={{ position: 'absolute', left: 8, top: 8, display: 'flex', gap: 6, pointerEvents: 'none', zIndex: 2 }}>
                        <span style={{ background: 'rgba(11,12,16,0.78)', color: PAL.text2, fontFamily: MONO, fontSize: 10, padding: '2px 7px', borderRadius: 3 }}>▼ Older · {baseLabel}</span>
                        <span style={{ background: 'rgba(11,12,16,0.78)', color: PAL.text2, fontFamily: MONO, fontSize: 10, padding: '2px 7px', borderRadius: 3 }}>▲ Newer · {targetLabel}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Pair the LCS op stream into aligned [left, right] rows for the split view:
// a run of dels + adds becomes change rows (del on left, add on right); eq rows
// show identical text on both sides.
function pairOps(ops) {
    const rows = [];
    let i = 0;
    while (i < ops.length) {
        if (ops[i].t === 'eq') {
            rows.push({ l: ops[i].line, r: ops[i].line, lt: 'eq', rt: 'eq' });
            i++;
            continue;
        }
        const dels = [];
        const adds = [];
        while (i < ops.length && ops[i].t === 'del') { dels.push(ops[i].line); i++; }
        while (i < ops.length && ops[i].t === 'add') { adds.push(ops[i].line); i++; }
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
            rows.push({
                l: k < dels.length ? dels[k] : null,
                r: k < adds.length ? adds[k] : null,
                lt: k < dels.length ? 'del' : 'none',
                rt: k < adds.length ? 'add' : 'none',
            });
        }
    }
    return rows;
}

const DIFF_CAP = 4000;

function SourceDiff({ a, b }) {
    const ops = React.useMemo(() => lineDiff(toLines(a), toLines(b)), [a, b]);
    const rows = React.useMemo(() => pairOps(ops), [ops]);
    const [mode, setMode] = React.useState('split');
    const [showAllDiff, setShowAllDiff] = React.useState(false);
    const adds = ops.filter((o) => o.t === 'add').length;
    const dels = ops.filter((o) => o.t === 'del').length;

    // Reset show-all when the diff input changes.
    React.useEffect(() => { setShowAllDiff(false); }, [a, b]);

    const cellBg = (t) => (t === 'add' ? 'rgba(46,160,67,0.16)' : t === 'del' ? 'rgba(248,81,73,0.16)' : t === 'none' ? 'rgba(255,255,255,0.02)' : 'transparent');
    const cellEdge = (t) => (t === 'add' ? '#2ea043' : t === 'del' ? '#f85149' : 'transparent');
    const halfStyle = (t) => ({
        flex: 1,
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        padding: '0 10px',
        background: cellBg(t),
        color: t === 'eq' ? '#8b949e' : t === 'none' ? '#3b4048' : '#e6e6e6',
        borderLeft: '3px solid ' + cellEdge(t),
    });

    const unifiedRowStyle = (t) => ({
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        padding: '0 10px',
        background: t === 'add' ? 'rgba(46,160,67,0.16)' : t === 'del' ? 'rgba(248,81,73,0.16)' : 'transparent',
        color: t === 'eq' ? '#8b949e' : '#e6e6e6',
        borderLeft: '3px solid ' + cellEdge(t),
    });
    const sign = (t) => (t === 'add' ? '+' : t === 'del' ? '-' : ' ');

    return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: '#11151a', color: '#9aa0a6', fontFamily: MONO, fontSize: 12, borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
                <span style={{ color: '#f85149' }}>-{dels}</span> <span style={{ color: '#81c995' }}>+{adds}</span>
                <span>older &rarr; newer</span>
                <div style={{ flex: 1 }} />
                <Seg items={[['split', 'Split'], ['unified', 'Unified']]} active={mode} onSelect={setMode} />
            </div>
            {mode === 'unified' ? (
                <div style={{ flex: 1, overflow: 'auto', fontFamily: MONO, fontSize: 12, lineHeight: 1.5, padding: '6px 0', background: '#0b0c10' }}>
                    {(showAllDiff || ops.length <= DIFF_CAP ? ops : ops.slice(0, DIFF_CAP)).map((o, i) => (
                        <div key={i} style={unifiedRowStyle(o.t)}>
                            {sign(o.t)} {o.line}
                        </div>
                    ))}
                    {!showAllDiff && ops.length > DIFF_CAP ? (
                        <div
                            style={{ padding: '0 10px', cursor: 'pointer', color: '#4FA7D6', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                            onClick={() => setShowAllDiff(true)}
                        >
                            {'… ' + (ops.length - DIFF_CAP) + ' more lines, show all'}
                        </div>
                    ) : null}
                </div>
            ) : (
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', fontFamily: MONO, fontSize: 11, color: '#9aa0a6', background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        <div style={{ flex: 1, padding: '4px 12px', borderRight: '1px solid rgba(255,255,255,0.12)', color: '#8ab4f8' }}>OLDER</div>
                        <div style={{ flex: 1, padding: '4px 12px', color: '#81c995' }}>NEWER</div>
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', fontFamily: MONO, fontSize: 12, lineHeight: 1.5, padding: '6px 0', background: '#0b0c10' }}>
                        {(showAllDiff || rows.length <= DIFF_CAP ? rows : rows.slice(0, DIFF_CAP)).map((row, i) => (
                            <div key={i} style={{ display: 'flex' }}>
                                <div style={{ ...halfStyle(row.lt), borderRight: '1px solid rgba(255,255,255,0.08)' }}>{row.l != null ? row.l : ''}</div>
                                <div style={halfStyle(row.rt)}>{row.r != null ? row.r : ''}</div>
                            </div>
                        ))}
                        {!showAllDiff && rows.length > DIFF_CAP ? (
                            <div
                                style={{ display: 'flex', cursor: 'pointer' }}
                                onClick={() => setShowAllDiff(true)}
                            >
                                <div style={{ flex: 1, padding: '0 10px', color: '#4FA7D6' }}>
                                    {'… ' + (rows.length - DIFF_CAP) + ' more lines, show all'}
                                </div>
                                <div style={{ flex: 1, padding: '0 10px' }} />
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}
