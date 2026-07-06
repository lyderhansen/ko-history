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

// Slots and searches always target THIS app. Never user-configurable.
export const PREVIEW_APP = 'ko_history';
// Backup index used by ko_version.xml (note: it's "ko_history", not "ko_backup").
export const KO_INDEX = 'ko_history';
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

// Quote a literal for safe interpolation into an SPL string match.
export function splQuote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Run a blocking oneshot search and return the result rows (array of objects).
export function oneshot(search, opts) {
    const o = opts || {};
    const earliest = o.earliest != null ? o.earliest : '0';
    const latest = o.latest != null ? o.latest : 'now';
    const count = o.count != null ? o.count : 0;
    const url =
        rawUrl('/servicesNS/nobody/' + encodeURIComponent(PREVIEW_APP) + '/search/jobs') + '?output_mode=json';
    const spl = search.trim().charAt(0) === '|' ? search : 'search ' + search;
    const body = encodeForm({
        search: spl,
        exec_mode: 'oneshot',
        output_mode: 'json',
        earliest_time: earliest,
        latest_time: latest,
        count: count,
    });
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: headers(), body })
        .then((r) => {
            if (!r.ok) return r.text().then((t) => Promise.reject(new Error('search HTTP ' + r.status + ' ' + t.slice(0, 200))));
            return r.json();
        })
        .then((j) => (j && j.results ? j.results : []));
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
                return r2.text().then((t) => Promise.reject(new Error('create view HTTP ' + r2.status + ' ' + t.slice(0, 200))));
            });
        }
        return resp.text().then((t) => Promise.reject(new Error('update view HTTP ' + resp.status + ' ' + t.slice(0, 200))));
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
                    return resp.text().then((t) => Promise.reject(new Error('restore HTTP ' + resp.status + ' ' + t.slice(0, 200))));
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
                return r2.text().then((t) => Promise.reject(new Error('create view HTTP ' + r2.status + ' ' + t.slice(0, 200))));
            });
        });
}

// Fields we never POST back when restoring a saved search: ACL/ownership (v1
// decision — restore writes config only, never sharing/owner), the title/app
// locators (carried in the URL), and server-computed/eai read-only fields.
const SS_RESTORE_DROP = {
    owner: 1, sharing: 1, title: 1, appName: 1, app: 1, file: 1, updated: 1,
    next_scheduled_time: 1, is_visible: 1, qualifiedSearch: 1,
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
                        : resp.text().then((t) => Promise.reject(new Error('restore HTTP ' + resp.status + ' ' + t.slice(0, 200)))));
            }
            const createUrl = rawUrl(base) + '?output_mode=json';
            return fetch(createUrl, { method: 'POST', credentials: 'same-origin', headers: h, body: encodeForm(Object.assign({ name: name }, body)) })
                .then((r2) => r2.ok ? { created: true }
                    : r2.text().then((t) => Promise.reject(new Error('create HTTP ' + r2.status + ' ' + t.slice(0, 200)))));
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
