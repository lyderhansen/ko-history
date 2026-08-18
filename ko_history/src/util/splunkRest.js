/*
 * Authenticated, same-origin Splunk REST helpers for the KO History wrapper.
 *
 * The wrapper runs as a normal Splunk Web app page (NOT a Dashboard Studio
 * custom viz), so — unlike the sandboxed DS case — it has cookies, CSRF, and
 * same-origin fetch. That lets us run searches and POST dashboard source into
 * "preview slot" views, then iframe those slots. This is the same write-then-
 * iframe pattern proven in ko_history's dashboard_preview viz, lifted into the
 * app page where it works for BOTH Simple XML and Dashboard Studio sources.
 */

import { parseExtractionTitle, tagNames, parseLookupDefinition } from './koRestoreParse';
import { parseSettings, serializeSettings, effectiveAllowed } from './restoreSettings';
import { runJob } from './searchJob';

// Slots and searches always target THIS app. Never user-configurable.
export const PREVIEW_APP = 'ko_history';
// Backup index used by ko_version.xml (note: it's "ko_history", not "ko_backup").
// The index name the app SHIPS with. This is the default and the placeholder,
// not the live value: since 1.3.0 the live name lives in the ko_history_index
// search macro, and every search resolves it there rather than here.
//
// The wrapper gets that for free. Its searches are dispatched at
// /servicesNS/nobody/ko_history/search/jobs (see oneshot), which is the app
// namespace the macro is defined in, so `index=`ko_history_index`` resolves
// server-side with no runtime lookup on our part.
export const KO_INDEX = 'ko_history';

// The macro that holds the live index name.
export const INDEX_MACRO = 'ko_history_index';
const MACRO_COLLECTION = '/servicesNS/nobody/' + PREVIEW_APP + '/configs/conf-macros';
const MACRO_PATH = MACRO_COLLECTION + '/' + INDEX_MACRO;

// Splunk index names: lowercase letters, digits, underscore and hyphen; cannot
// begin with an underscore (reserved for internal indexes) and cannot be empty.
// Validated here as well as in the UI so a bad value cannot reach splunkd
// through any caller.
export function validateIndexName(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return 'Enter an index name.';
    if (s.length > 255) return 'Index names are limited to 255 characters.';
    if (s.charAt(0) === '_') return 'Index names cannot start with an underscore, which Splunk reserves for internal indexes.';
    if (!/^[a-z0-9_-]+$/.test(s)) return 'Use lowercase letters, digits, underscore and hyphen only.';
    return '';
}
// Source discriminators the dashboard's koType token expects.
export const VIEW_SOURCES = ['ko_views_xml_backup', 'ko_views_delete_audit', 'ko_all_delete_audit'];
// Saved-search (report/alert) sources — the reports half of the koType dropdown.
export const REPORT_SOURCES = ['ko_reports_and_alerts_backup', 'ko_reports_and_alerts_delete_audit', 'ko_all_delete_audit'];
// Generic non-dashboard KO sources (Phase 3). New types add their pair here.
export const MACRO_SOURCES = ['ko_macros_backup', 'ko_macros_delete_audit', 'ko_all_delete_audit'];
export const EVENTTYPE_SOURCES = ['ko_eventtypes_backup', 'ko_eventtypes_delete_audit', 'ko_all_delete_audit'];
export const FIELDEXTRACTION_SOURCES = ['ko_fieldextractions_backup', 'ko_fieldextractions_delete_audit', 'ko_all_delete_audit'];
export const LOOKUP_SOURCES = ['ko_lookups_backup', 'ko_lookups_delete_audit', 'ko_all_delete_audit'];
export const TAG_SOURCES = ['ko_tags_backup', 'ko_tags_delete_audit', 'ko_all_delete_audit'];

// Map a marker `ko_class` to its summary-index source pair. Returns null for an
// unknown class so the caller can fall back to all KO sources (title-scoped).
export function sourcesForClass(koClass) {
    if (koClass === 'dashboard') return VIEW_SOURCES;
    if (koClass === 'savedsearch') return REPORT_SOURCES;
    if (koClass === 'macro') return MACRO_SOURCES;
    if (koClass === 'eventtype') return EVENTTYPE_SOURCES;
    if (koClass === 'fieldextraction') return FIELDEXTRACTION_SOURCES;
    if (koClass === 'lookup') return LOOKUP_SOURCES;
    if (koClass === 'tag') return TAG_SOURCES;
    return null;
}

// Sanitize a username for use in a Splunk view name.
// View names allow [A-Za-z0-9_-]; lowercase and replace everything else with '_'.
// Returns an empty string when username is unavailable.
function sanitizeUsername(u) {
    if (!u || typeof u !== 'string') return '';
    return u.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

// Returns the current Splunk username, sanitized for view-name use, or '' if unavailable.
// Reads from @splunk/splunk-utils/config (which itself reads window.$C.USERNAME).
function currentUserSuffix() {
    let raw = '';
    try {
        // @splunk/splunk-utils/config.username reads window.$C.USERNAME
        // eslint-disable-next-line global-require
        raw = require('@splunk/splunk-utils/config').username || '';
    } catch (e) {
        // Module unavailable (e.g. test environment) — fall back to $C directly
        try { raw = (window.$C && window.$C.USERNAME) || ''; } catch (e2) { /* */ }
    }
    const s = sanitizeUsername(raw);
    return s ? '_' + s : '';
}

// Slot names for the wrapper's compare pane.  Suffixed per-user so concurrent
// comparisons by different users don't overwrite each other's slots.
// Falls back to the unsuffixed names when the username is unavailable.
export const SLOT_BASELINE = 'kohist_cmp_baseline' + currentUserSuffix();
export const SLOT_TARGET   = 'kohist_cmp_target'   + currentUserSuffix();

function locale() {
    const seg = window.location.pathname.split('/').filter(Boolean);
    return seg[0] || 'en-US';
}

function getCsrf() {
    let raw = '';
    try {
        raw = document.cookie;
    } catch (e) {
        return '';
    }
    const cookies = raw ? raw.split(';') : [];
    for (let i = 0; i < cookies.length; i++) {
        const c = cookies[i].replace(/^\s+/, '');
        if (c.indexOf('splunkweb_csrf_token') === 0) {
            const eq = c.indexOf('=');
            if (eq > 0) return decodeURIComponent(c.substring(eq + 1));
        }
    }
    return '';
}

function encodeForm(obj) {
    return Object.keys(obj)
        .filter((k) => obj[k] !== undefined && obj[k] !== null)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
        .join('&');
}

function rawUrl(path) {
    return '/' + locale() + '/splunkd/__raw' + path;
}

function headers() {
    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Splunk-Form-Key': getCsrf(),
        'X-Requested-With': 'XMLHttpRequest',
    };
}

/*
 * Turn a splunkd error body into a sentence.
 *
 * splunkd answers a refused write with
 *   {"messages":[{"type":"ERROR","text":"User 'x' with roles { a, b } cannot
 *    write: /nobody/app/views/name { read : [ * ], write : [ admin ] } ..."}]}
 * and pasting that verbatim into a dialog, which is what used to happen, hands
 * the user a wall of JSON to decode. Pull the text out, and for the one case
 * that actually matters (403) replace it with something actionable: the raw
 * message names an internal ACL path the reader cannot act on anyway.
 */
export function splunkErrorText(status, bodyText, whatFailed) {
    let text = '';
    try {
        const body = JSON.parse(bodyText);
        if (body && body.messages && body.messages.length) {
            text = String(body.messages[0].text || '');
        }
    } catch (e) {
        text = String(bodyText || '').slice(0, 200);
    }
    if (status === 403) {
        // Recover the app name from ".../nobody/<app>/views/<name>" when present,
        // so the message can say WHERE the user lacks access.
        const m = /cannot write:\s*\/[^/]+\/([^/]+)\//.exec(text);
        const where = m ? ' in the ' + m[1] + ' app' : '';
        return (whatFailed || 'That write') + ' needs write access' + where +
               ', which your account does not have. Ask a Splunk admin, or pick an app you can write to.';
    }
    return (whatFailed || 'The request') + ' failed (HTTP ' + status + ')' +
           (text ? ': ' + text.slice(0, 200) : '');
}

/*
 * May this user create an object in <app>/<collection>?
 *
 * splunkd advertises a `create` link on a collection exactly when the caller may
 * POST a new entry to it, so one cheap GET answers the question without
 * attempting a write. Used to disable controls the user could never complete
 * instead of letting them fill in a form and collect a 403.
 *
 * Resolves false on any doubt.
 */
export function canCreateIn(appName, collection) {
    // count=1, NOT count=0. In the Splunk REST API count=0 means "no limit", so
    // this probe was pulling every entry the app context can see — for
    // data/ui/views that is every dashboard including globally-shared ones from
    // other apps, each carrying its complete eai:data. Megabytes through
    // JSON.parse on the main thread, re-run on every restore target-app change,
    // to read one boolean. The links.create field is on the collection itself,
    // so one entry is as good as all of them; f=title keeps that entry small.
    const url = rawUrl('/servicesNS/nobody/' + encodeURIComponent(appName) + '/' + collection) +
        '?output_mode=json&count=1&f=title';
    return fetch(url, { method: 'GET', credentials: 'same-origin', headers: headers() })
        .then((resp) => {
            if (!resp.ok) return false;
            return resp.text().then((t) => {
                try {
                    const body = JSON.parse(t);
                    return !!(body && body.links && body.links.create);
                } catch (e) {
                    return false;
                }
            });
        })
        .catch(() => false);
}

// Can this user write the preview slot views this app renders comparisons into?
// Everything in the compare and preview flow depends on it.
export function canWritePreviewSlots() {
    return canCreateIn(PREVIEW_APP, 'data/ui/views');
}

// Quote a literal for safe interpolation into an SPL string match.
export function splQuote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Run a search and return the result rows (array of objects).
//
// Dispatched as a normal (async) job and polled to completion rather than
// exec_mode=oneshot. A oneshot blocks server-side, and fetch has no default
// timeout, so a slow search used to leave this promise pending forever: the
// wrapper's spinner never resolved and re-selecting the KO (which aborts and
// re-issues) appeared to "fix" it. The state machine lives in searchJob.js.
//
// Signature and resolved shape are unchanged; every existing caller is
// unaffected, including `opts.signal` aborts.
export function oneshot(search, opts) {
    const o = opts || {};
    const earliest = o.earliest != null ? o.earliest : '0';
    const latest = o.latest != null ? o.latest : 'now';
    const count = o.count != null ? o.count : 0;
    const base = '/servicesNS/nobody/' + encodeURIComponent(PREVIEW_APP) + '/search/jobs';
    const spl = search.trim().charAt(0) === '|' ? search : 'search ' + search;
    return runJob({
        fetchImpl: (url, init) => fetch(url, init),
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        headers: headers(),
        signal: o.signal,
        createUrl: rawUrl(base) + '?output_mode=json',
        createBody: encodeForm({
            search: spl,
            exec_mode: 'normal',
            output_mode: 'json',
            earliest_time: earliest,
            latest_time: latest,
        }),
        jobUrlFor: (sid) => rawUrl(base + '/' + encodeURIComponent(sid)) + '?output_mode=json',
        // count=0 means "all rows", matching the previous oneshot behavior.
        resultsUrlFor: (sid) =>
            rawUrl(base + '/' + encodeURIComponent(sid) + '/results') + '?output_mode=json&count=' + count,
    });
}

// Create-or-overwrite a view with the given dashboard XML (eai:data envelope).
export function upsertView(viewName, xmlData) {
    const h = headers();
    const base = '/servicesNS/nobody/' + encodeURIComponent(PREVIEW_APP) + '/data/ui/views';
    const updateUrl = rawUrl(base + '/' + encodeURIComponent(viewName)) + '?output_mode=json';
    return fetch(updateUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: h,
        body: encodeForm({ 'eai:data': xmlData }),
    }).then((resp) => {
        if (resp.ok) return resp;
        if (resp.status === 404) {
            const createUrl = rawUrl(base) + '?output_mode=json';
            return fetch(createUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: h,
                body: encodeForm({ name: viewName, 'eai:data': xmlData }),
            }).then((r2) => {
                if (r2.ok) return r2;
                return r2.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(r2.status, t, 'Creating the preview view')), { code: r2.status === 403 ? 'FORBIDDEN' : 'HTTP' })));
            });
        }
        return resp.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(resp.status, t, 'Updating the preview view')), { code: resp.status === 403 ? 'FORBIDDEN' : 'HTTP' })));
    });
}

// Probe whether a view (dashboard) already exists in an app. Returns a Promise
// that resolves to true (200 exists), false (404 not found), or null (any other
// status or network error — unknown/checking state). Used by the restore modal
// for the live name-availability check. Does NOT require write access — a GET
// on the item endpoint returns 200 (exists) or 404 (not found).
export function viewExists(appName, viewName) {
    const url = rawUrl('/servicesNS/nobody/' + encodeURIComponent(appName) + '/data/ui/views/' + encodeURIComponent(viewName)) + '?output_mode=json';
    return fetch(url, { method: 'GET', credentials: 'same-origin', headers: headers() })
        .then((r) => r.status === 200 ? true : r.status === 404 ? false : null)
        .catch(() => null);
}

// Probe whether a saved search already exists in an app. Returns a Promise
// resolving to true (200 exists), false (404 not found), or null (any other
// status or network error — unknown/checking state).
export function savedSearchExists(appName, name) {
    const url = rawUrl('/servicesNS/nobody/' + encodeURIComponent(appName) + '/saved/searches/' + encodeURIComponent(name)) + '?output_mode=json';
    return fetch(url, { method: 'GET', credentials: 'same-origin', headers: headers() })
        .then((r) => r.status === 200 ? true : r.status === 404 ? false : null)
        .catch(() => null);
}

// Create-or-overwrite a view in an ARBITRARY app. Used by Restore — this writes
// a REAL dashboard (not a scratch preview slot), so the app is a parameter and
// the caller must gate it behind explicit confirmation. Returns {created} so the
// UI can say "Created" vs "Overwrote". A 403 here means the user lacks write on
// that app's views (RBAC is the real guard).
//
// allowOverwrite (default false): when false and the target already exists, rejects
// with an error whose .code === 'EXISTS'. The caller must pass allowOverwrite:true
// to overwrite an existing view — never the default path.
export function restoreView(appName, viewName, xmlData, allowOverwrite) {
    const h = headers();
    const base = '/servicesNS/nobody/' + encodeURIComponent(appName) + '/data/ui/views';
    const updateUrl = rawUrl(base + '/' + encodeURIComponent(viewName)) + '?output_mode=json';
    // Existence probe: GET the item. 200 → exists, 404 → free to create.
    return fetch(updateUrl, { method: 'GET', credentials: 'same-origin', headers: h })
        .then((probe) => {
            if (probe.status !== 404) {
                // Exists — overwrite only when explicitly opted-in.
                if (!allowOverwrite) {
                    const err = new Error('EXISTS');
                    err.code = 'EXISTS';
                    return Promise.reject(err);
                }
                return fetch(updateUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: h,
                    body: encodeForm({ 'eai:data': xmlData }),
                }).then((resp) => {
                    if (resp.ok) return { created: false };
                    return resp.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(resp.status, t, 'Restoring')), { code: resp.status === 403 ? 'FORBIDDEN' : 'HTTP' })));
                });
            }
            // Does not exist — create.
            const createUrl = rawUrl(base) + '?output_mode=json';
            return fetch(createUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: h,
                body: encodeForm({ name: viewName, 'eai:data': xmlData }),
            }).then((r2) => {
                if (r2.ok) return { created: true };
                return r2.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(r2.status, t, 'Creating the preview view')), { code: r2.status === 403 ? 'FORBIDDEN' : 'HTTP' })));
            });
        });
}

// Fields we never POST back when restoring a saved search: ACL/ownership (v1
// decision — restore writes config only, never sharing/owner), the title/app
// locators (carried in the URL), and server-computed/eai read-only fields.
const SS_RESTORE_DROP = {
    owner: 1, sharing: 1, title: 1, appName: 1, app: 1, file: 1, updated: 1,
    next_scheduled_time: 1, is_visible: 1, qualifiedSearch: 1,
    user: 1, // audit-only field — must not be written into a restored saved search
};
// Reduce a captured saved-search field map to a writable POST body: drop ACL +
// read-only keys and any eai:* / empty values (empties would error or clobber).
// `search` is always kept (required to create). Dotted action.*/alert.* keys pass
// straight through — the /saved/searches endpoint accepts them verbatim.
function ssRestoreBody(fields) {
    const body = {};
    Object.keys(fields || {}).forEach((k) => {
        if (k.indexOf('eai:') === 0 || k.charAt(0) === '_') return;
        if (SS_RESTORE_DROP[k]) return;
        const v = fields[k];
        if (v == null) return;
        if (String(v) === '' && k !== 'search') return;
        body[k] = v;
    });
    return body;
}

// Create-or-overwrite a saved search (report/alert) in an arbitrary app. The
// counterpart to restoreView, for the reports half. Owner is always `nobody`
// (app-shared) — ACL/owner restore is intentionally out of scope in v1, so the
// caller must surface "Owner: nobody (app-shared)" in its confirm modal. Returns
// {created}. A 403 means the user lacks write on that app's saved searches.
//
// allowOverwrite (default false): when false and the target already exists,
// rejects with error.code === 'EXISTS'. Pass allowOverwrite:true for an explicit
// user-confirmed overwrite.
export function upsertSavedSearch(appName, name, fields, allowOverwrite) {
    const h = headers();
    const body = ssRestoreBody(fields);
    const base = '/servicesNS/nobody/' + encodeURIComponent(appName) + '/saved/searches';
    const updateUrl = rawUrl(base + '/' + encodeURIComponent(name)) + '?output_mode=json';
    // Existence probe: GET the item.
    return fetch(updateUrl, { method: 'GET', credentials: 'same-origin', headers: h })
        .then((probe) => {
            if (probe.status !== 404) {
                // Exists — overwrite only when explicitly opted-in.
                if (!allowOverwrite) {
                    const err = new Error('EXISTS');
                    err.code = 'EXISTS';
                    return Promise.reject(err);
                }
                return fetch(updateUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: h,
                    body: encodeForm(body),
                }).then((resp) => {
                    if (resp.ok) return { created: false };
                    return resp.text().then((t) => Promise.reject(new Error('restore saved search HTTP ' + resp.status + ' ' + t.slice(0, 200))));
                });
            }
            // Does not exist — create.
            const createUrl = rawUrl(base) + '?output_mode=json';
            return fetch(createUrl, {
                method: 'POST',
                credentials: 'same-origin',
                headers: h,
                body: encodeForm(Object.assign({ name: name }, body)),
            }).then((r2) => {
                if (r2.ok) return { created: true };
                return r2.text().then((t) => Promise.reject(new Error('create saved search HTTP ' + r2.status + ' ' + t.slice(0, 200))));
            });
        });
}

// ── Generic restore (macro / eventtype / tag / fieldextraction / lookup) ──────
// Mirrors upsertSavedSearch's probe → reject-or-overwrite → create dance, but
// for an arbitrary REST collection. `restPath` is the collection path under
// /servicesNS/nobody/<app>/ (e.g. 'data/macros'). `body` is the writable field
// map; create adds `name`. Same EXISTS/allowOverwrite contract as restoreView.
function upsertItem(restPath, appName, name, body, allowOverwrite) {
    const h = headers();
    const base = '/servicesNS/nobody/' + encodeURIComponent(appName) + '/' + restPath;
    const itemUrl = rawUrl(base + '/' + encodeURIComponent(name)) + '?output_mode=json';
    return fetch(itemUrl, { method: 'GET', credentials: 'same-origin', headers: h })
        .then((probe) => {
            if (probe.status !== 404) {
                if (!allowOverwrite) {
                    const err = new Error('EXISTS'); err.code = 'EXISTS'; return Promise.reject(err);
                }
                return fetch(itemUrl, { method: 'POST', credentials: 'same-origin', headers: h, body: encodeForm(body) })
                    .then((resp) => resp.ok ? { created: false }
                        : resp.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(resp.status, t, 'Restoring')), { code: resp.status === 403 ? 'FORBIDDEN' : 'HTTP' }))));
            }
            const createUrl = rawUrl(base) + '?output_mode=json';
            return fetch(createUrl, { method: 'POST', credentials: 'same-origin', headers: h, body: encodeForm(Object.assign({ name: name }, body)) })
                .then((r2) => r2.ok ? { created: true }
                    : r2.text().then((t) => Promise.reject(Object.assign(new Error(splunkErrorText(r2.status, t, 'Restoring')), { code: r2.status === 403 ? 'FORBIDDEN' : 'HTTP' }))));
        });
}

function macroBody(f) {
    const b = { definition: f.definition || '' };
    if (f.iseval != null && String(f.iseval) !== '') b.iseval = f.iseval;
    if (f.args) b.args = f.args;
    return b;
}

function tagBody(f) {
    const b = {};
    tagNames(f.definition).forEach((n) => { b[n] = 'enabled'; });
    return b;
}

function lookupBody(f) {
    const d = parseLookupDefinition(f.definition || '');
    const b = {};
    if (d.filename) b.filename = d.filename;            // file lookups
    if (d.collection) b.collection_name = d.collection; // kvstore lookups (best-effort)
    return b;
}

// Field extractions are special: the REST item name is "<stanza> : <attribute>"
// but CREATE takes the BARE class as `name` plus `stanza` + `type`, and the
// endpoint composes the attribute as "<type>-<name>". So probe/overwrite use the
// full title; create uses the parsed parts.
function restoreFieldExtraction(appName, fullName, fields, allowOverwrite) {
    const h = headers();
    const p = parseExtractionTitle(fullName);
    const base = '/servicesNS/nobody/' + encodeURIComponent(appName) + '/data/props/extractions';
    const itemUrl = rawUrl(base + '/' + encodeURIComponent(fullName)) + '?output_mode=json';
    const value = fields.value || '';
    return fetch(itemUrl, { method: 'GET', credentials: 'same-origin', headers: h })
        .then((probe) => {
            if (probe.status !== 404) {
                if (!allowOverwrite) { const err = new Error('EXISTS'); err.code = 'EXISTS'; return Promise.reject(err); }
                return fetch(itemUrl, { method: 'POST', credentials: 'same-origin', headers: h, body: encodeForm({ value: value }) })
                    .then((resp) => resp.ok ? { created: false }
                        : resp.text().then((t) => Promise.reject(new Error('restore extraction HTTP ' + resp.status + ' ' + t.slice(0, 200)))));
            }
            return fetch(rawUrl(base) + '?output_mode=json', {
                method: 'POST', credentials: 'same-origin', headers: h,
                body: encodeForm({ name: p.klass, stanza: p.stanza, type: p.type, value: value }),
            }).then((r2) => r2.ok ? { created: true }
                : r2.text().then((t) => Promise.reject(new Error('create extraction HTTP ' + r2.status + ' ' + t.slice(0, 200)))));
        });
}

// Dispatcher used by the wrapper: routes a generic KO restore to the right
// endpoint. Dashboards/saved searches keep their own functions (restoreView /
// upsertSavedSearch) and are NOT routed here.
export function restoreKO(koClass, appName, name, fields, allowOverwrite) {
    switch (koClass) {
        case 'macro':           return upsertItem('data/macros', appName, name, macroBody(fields), allowOverwrite);
        case 'eventtype':       return upsertItem('saved/eventtypes', appName, name, { search: fields.search || '' }, allowOverwrite);
        case 'tag':             return upsertItem('configs/conf-tags', appName, name, tagBody(fields), allowOverwrite);
        case 'lookup':          return upsertItem('data/transforms/lookups', appName, name, lookupBody(fields), allowOverwrite);
        case 'fieldextraction': return restoreFieldExtraction(appName, name, fields, allowOverwrite);
        default: return Promise.reject(new Error('Restore not supported for type: ' + koClass));
    }
}

// Manager URL of a restored generic KO (for the post-restore "open" link).
const KO_MANAGER_PATH = {
    macro: 'data/macros', eventtype: 'saved/eventtypes',
    fieldextraction: 'data/props/extractions', lookup: 'data/transforms/lookups', tag: 'saved/fvtags',
};
export function koManagerUrl(koClass, appName, name) {
    const path = KO_MANAGER_PATH[koClass];
    if (!path) return viewUrl(appName, name);
    const search = koClass === 'tag' ? '%22' + encodeURIComponent(name) + '%22' : encodeURIComponent(name);
    return '/' + locale() + '/manager/' + encodeURIComponent(appName) + '/' + path +
        '?ns=' + encodeURIComponent(appName) + '&pwnr=-&search=' + search;
}

// Plain app URL for a restored saved search (opens its detail/edit page).
export function savedSearchUrl(appName, name) {
    return '/' + locale() + '/manager/' + encodeURIComponent(appName) + '/saved/searches/' +
        encodeURIComponent(name) + '?action=edit&ns=' + encodeURIComponent(appName);
}

// List installed apps (id + label) for the restore target picker.
export function listApps() {
    return oneshot('| rest /services/apps/local | table title label')
        .then((rows) => rows.map((r) => ({ id: r.title, label: r.label || r.title })))
        .then((rows) => rows.sort((a, b) => a.id.localeCompare(b.id)));
}

// Plain app/view URL (no chrome stripping) — to open a restored dashboard.
export function viewUrl(appName, viewName) {
    return '/' + locale() + '/app/' + encodeURIComponent(appName) + '/' + encodeURIComponent(viewName);
}

// URL for a slot view, chrome stripped, cache-busted so the iframe reloads.
export function previewUrl(viewName, cacheBuster) {
    const chrome = ['hideEdit=true', 'hideTitle=true', 'hideChrome=true', 'hideSplunkBar=true', 'hideAppBar=true', 'hideFooter=true'];
    return (
        '/' +
        locale() +
        '/app/' +
        encodeURIComponent(PREVIEW_APP) +
        '/' +
        encodeURIComponent(viewName) +
        '?' +
        chrome.join('&') +
        '&_cb=' +
        encodeURIComponent(cacheBuster)
    );
}

// ── App settings: the [restore] stanza of ko_history.conf ────────────────────
//
// Restore is opt-in, so both of these fail closed. A missing stanza, a refused
// read and an unparseable body all leave `enabled` empty, which the gate in
// restoreSettings.effectiveAllowed() turns into "nothing is restorable".
//
// The stanza is addressed under `nobody` so every user reads the same app-level
// setting rather than a per-user copy.
const SETTINGS_COLLECTION =
    '/servicesNS/nobody/' + encodeURIComponent(PREVIEW_APP) + '/configs/conf-ko_history';
const SETTINGS_PATH = SETTINGS_COLLECTION + '/restore';

// Every request here is bounded. fetch has no default timeout, and a splunkd
// that accepts the connection but never answers would otherwise leave the
// wrapper in 'loading' forever with restore blocked and no way to retry. Same
// reasoning, and the same 30s, as searchJob.js.
const SETTINGS_TIMEOUT_MS = 30000;

function fetchSettings(url, init) {
    // Aborting is safe here in a way it is not for search jobs: these are plain
    // conf reads and writes with no server-side job to strand.
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const opts = Object.assign({ credentials: 'same-origin', headers: headers() }, init);
    if (ctl) opts.signal = ctl.signal;

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (ctl) { try { ctl.abort(); } catch (e) { /* already gone */ } }
            const err = new Error('settings request timed out after ' + SETTINGS_TIMEOUT_MS + 'ms');
            err.code = 'TIMEOUT';
            reject(err);
        }, SETTINGS_TIMEOUT_MS);
    });

    return Promise.race([fetch(url, opts), timeout]).then(
        (resp) => { clearTimeout(timer); return resp; },
        (e) => {
            clearTimeout(timer);
            if (e && e.code) throw e;
            // An abort surfaces as an AbortError; anything else is a network
            // failure. Both are "we could not read it", never "it is off".
            const err = new Error((e && e.message) || 'settings request failed');
            err.code = 'READ_FAILED';
            throw err;
        }
    );
}

// Resolves { found, missing, enabled, canWrite }.
//
// `canWrite` comes from the stanza's own ACL, so the settings page decides
// read-only mode without hardcoding a role name anywhere. `missing` separates
// "this install has no such stanza" from a transient failure: the first is a
// quiet, expected state, the second deserves an error message.
export function readRestoreSettings() {
    const url = rawUrl(SETTINGS_PATH) + '?output_mode=json';
    return fetchSettings(url, { method: 'GET' })
        .then((resp) => {
            if (resp.status === 404) {
                // The stanza does not exist, so it has no ACL to ask. Writing a
                // NEW stanza is governed by the collection, so ask that instead:
                // hardcoding canWrite false here left an admin reading "saving
                // will create them" on a page with no Save button.
                return canWriteSettingsCollection().then((canWrite) => ({
                    found: false, missing: true, enabled: [], canWrite,
                }));
            }
            if (!resp.ok) {
                return resp.text().then((t) => {
                    const err = new Error('settings read HTTP ' + resp.status + ' ' + t.slice(0, 200));
                    err.code = resp.status === 403 ? 'FORBIDDEN' : 'READ_FAILED';
                    return Promise.reject(err);
                });
            }
            // Parse the text ourselves: resp.json() throws an opaque error on an
            // empty or non-JSON body, which is exactly when we want a clear one.
            return resp.text().then((t) => {
                let body;
                try {
                    body = JSON.parse(t);
                } catch (e) {
                    const err = new Error('settings read returned a non-JSON body');
                    err.code = 'READ_FAILED';
                    return Promise.reject(err);
                }
                return Object.assign({ missing: false }, parseSettings(body));
            });
        });
}

// May this user create the [restore] stanza? Only consulted when the stanza is
// absent, since a stanza that does not exist has no ACL of its own to ask.
//
// Splunk advertises a `create` link on a collection exactly when the caller may
// POST a new entry to it, which is the permission in question. Resolves false on
// any doubt: a wrong false costs a read-only page, a wrong true costs a Save
// button that fails on click.
function canWriteSettingsCollection() {
    const url = rawUrl(SETTINGS_COLLECTION) + '?output_mode=json&count=0';
    return fetchSettings(url, { method: 'GET' })
        .then((resp) => {
            if (!resp.ok) return false;
            return resp.text().then((t) => {
                try {
                    const body = JSON.parse(t);
                    return !!(body && body.links && body.links.create);
                } catch (e) {
                    return false;
                }
            });
        })
        .catch(() => false);
}

// Write the allow-list, then re-read so the caller renders what actually landed
// rather than what it hoped for. Every key is written, including the ones being
// turned off.
//
// Resolves the readRestoreSettings() shape plus `confirmed`. The distinction
// matters: if the POST succeeds and only the confirming re-read fails, the
// settings ARE on disk and restore may now be live. Reporting that as a failed
// save tells the admin the opposite of the truth, so the write resolves with
// confirmed:false and the values that were requested, rather than rejecting.
export function writeRestoreSettings(enabled) {
    const url = rawUrl(SETTINGS_PATH) + '?output_mode=json';
    return fetchSettings(url, { method: 'POST', body: serializeSettings(enabled) })
        .then((resp) => {
            if (!resp.ok) {
                return resp.text().then((t) => {
                    const err = new Error('settings write HTTP ' + resp.status + ' ' + t.slice(0, 200));
                    // 403 here means the ACL changed under us, or the page was
                    // left open by a user who has since lost write access.
                    err.code = resp.status === 403 ? 'FORBIDDEN' : 'WRITE_FAILED';
                    return Promise.reject(err);
                });
            }
            return readRestoreSettings()
                .then((res) => Object.assign({ confirmed: true }, res))
                .catch(() => ({
                    // The write landed. Report what we asked for, flagged as
                    // unconfirmed, so the UI can say "saved, could not re-read".
                    found: true,
                    missing: false,
                    enabled: effectiveAllowed(enabled),
                    canWrite: true,
                    confirmed: false,
                }));
        });
}

// ── index name (the ko_history_index macro) ─────────────────────────────────
//
// Read and write the search macro that every search in the app resolves the
// index name from. Same shape as readRestoreSettings/writeRestoreSettings,
// including the timeout and the fail-closed behaviour, because the failure
// modes are identical: a refused read must not look like a value.
//
// SCOPE, DELIBERATELY LIMITED: this changes where the app READS. It does NOT
// repoint the capture searches, whose target is action.summary_index._name, a
// saved-search setting that cannot reference a macro. Repointing those is the
// admin's job and is documented in DEPLOY.md and on the settings page itself.
// Doing half of it silently would be worse than not offering it, which is why
// the UI states the consequence rather than burying it in a tooltip.

export function readIndexName() {
    const url = rawUrl(MACRO_PATH) + '?output_mode=json';
    return fetchSettings(url, { method: 'GET' })
        .then((resp) => {
            if (resp.status === 404) {
                // Macro absent: the app is running on whatever the searches
                // hardcode, which after 1.3.0 means they resolve nothing. Report
                // it as missing rather than inventing the default, so the page
                // can say so instead of showing a value that is not in effect.
                return canCreateIn(PREVIEW_APP, 'configs/conf-macros')
                    .then((canWrite) => ({ found: false, name: '', canWrite }));
            }
            if (!resp.ok) {
                return resp.text().then((tx) => {
                    const err = new Error('index macro read HTTP ' + resp.status + ' ' + tx.slice(0, 200));
                    err.code = resp.status === 403 ? 'FORBIDDEN' : 'READ_FAILED';
                    return Promise.reject(err);
                });
            }
            return resp.text().then((tx) => {
                let body;
                try {
                    body = JSON.parse(tx);
                } catch (e) {
                    const err = new Error('index macro read returned a non-JSON body');
                    err.code = 'READ_FAILED';
                    return Promise.reject(err);
                }
                const entry = body && body.entry && body.entry[0];
                const content = (entry && entry.content) || {};
                const acl = (entry && entry.acl) || {};
                return {
                    found: true,
                    name: String(content.definition == null ? '' : content.definition).trim(),
                    // The stanza's own ACL, so no role name is hardcoded here.
                    canWrite: !!acl.can_write,
                };
            });
        });
}

export function writeIndexName(name) {
    const problem = validateIndexName(name);
    if (problem) return Promise.reject(Object.assign(new Error(problem), { code: 'INVALID' }));
    const clean = String(name).trim();
    const url = rawUrl(MACRO_PATH) + '?output_mode=json';
    return fetchSettings(url, { method: 'POST', body: encodeForm({ definition: clean }) })
        .then((resp) => {
            if (resp.status === 404) {
                // No stanza yet: create it on the collection instead of updating.
                const createUrl = rawUrl(MACRO_COLLECTION) + '?output_mode=json';
                return fetchSettings(createUrl, {
                    method: 'POST',
                    body: encodeForm({ name: INDEX_MACRO, definition: clean, iseval: '0' }),
                });
            }
            return resp;
        })
        .then((resp) => {
            if (!resp.ok) {
                return resp.text().then((tx) => {
                    const err = new Error('index macro write HTTP ' + resp.status + ' ' + tx.slice(0, 200));
                    err.code = resp.status === 403 ? 'FORBIDDEN' : 'WRITE_FAILED';
                    return Promise.reject(err);
                });
            }
            // Re-read so the caller renders what landed, not what it hoped for.
            // A write that succeeds while the confirming read fails resolves
            // with confirmed:false rather than rejecting: the value IS on disk,
            // and reporting that as a failure tells the admin the opposite of
            // the truth.
            return readIndexName()
                .then((res) => Object.assign({ confirmed: true }, res))
                .catch(() => ({ found: true, name: clean, canWrite: true, confirmed: false }));
        });
}
