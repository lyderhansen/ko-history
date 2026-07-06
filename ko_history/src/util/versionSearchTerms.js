/*
 * versionSearchTerms.js — indexed raw-term prefilter for per-KO version searches.
 *
 * Returns a fragment to insert into the BASE clause of a per-KO version search
 * (immediately after `source IN (...)`).  Adding the title as a quoted raw term
 * lets the indexed lexicon prune events cheaply; the post-eval `| search title=…`
 * remains as the exact filter.
 *
 * The backup searches store the KO name in TWO ways in _raw:
 *   - `title` field  — decoded (spaces as spaces, etc.)
 *   - `file`  field  — URL-encoded (%20, %3A, %21, %28, %29)
 * Audit events store the name in `file` only (URL-encoded).
 * We therefore OR both forms so the prefilter hits both event types.
 *
 * No browser dependencies.  Works as CommonJS (Node tests) and as a webpack
 * ES import (WrapperApp.jsx) — same dual-module idiom as koClass.js.
 */
'use strict';

// URL-encoding map: characters the dashboards URL-decode when normalising the
// `file` field (%20→space, %3A→:, %21→!, %28→(, %29→)).
var URL_ENCODE_MAP = {
    ' ': '%20',
    ':': '%3A',
    '!': '%21',
    '(': '%28',
    ')': '%29'
};

// URL-encode a title string using the same character set the dashboards decode,
// producing the form stored in the `file` field of audit/backup events.
function urlEncodeTitle(s) {
    var out = '';
    var i, c;
    for (i = 0; i < s.length; i++) {
        c = s[i];
        out += URL_ENCODE_MAP.hasOwnProperty(c) ? URL_ENCODE_MAP[c] : c;
    }
    return out;
}

// Escape a string for safe inclusion inside an SPL double-quoted term:
//   backslash → \\   (must be first to avoid double-escaping)
//   double-quote → \"
function splEscape(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Returns an indexed raw-term prefilter fragment for the per-KO version search
// base clause, e.g.:
//   ("My Dashboard" OR "My%20Dashboard")
//   ("hello")                             — when URL-encoded form == plain
//   ''                                    — for empty/degenerate titles
//
// Insert the result right after `source IN (…)` in the base clause; a trailing
// space is the caller's responsibility.
function versionSearchTerms(title) {
    if (title == null || String(title).replace(/^\s+|\s+$/g, '') === '') return '';
    var t = String(title);
    // Titles containing a double-quote are skipped entirely (no prefilter, i.e.
    // today's full-scan behavior): Splunk may store embedded quotes escaped in
    // _raw, and a phrase term that misses would silently hide versions — for a
    // backup tool, a slower exact search beats a fast wrong one.
    if (t.indexOf('"') !== -1) return '';
    var plain = splEscape(t);
    var encoded = splEscape(urlEncodeTitle(t));
    if (plain === encoded) {
        return '("' + plain + '")';
    }
    return '("' + plain + '" OR "' + encoded + '")';
}

module.exports = { versionSearchTerms: versionSearchTerms };
