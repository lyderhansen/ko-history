/*
 * Pure parsers for generic KO restore. CommonJS (module.exports) so they run
 * under plain `node` for unit tests AND are consumed by the webpack bundle via
 * `import { ... } from './koRestoreParse'` (webpack interops CommonJS).
 * No browser/DOM/fetch dependencies — keep it pure and ES5.
 */

// "<stanza> : <PREFIX>-<class>" (e.g. "access_combined : REPORT-access").
// The props/extractions endpoint only emits EXTRACT (inline) and REPORT
// (transform) attributes. Splits on the FIRST " : " so a stanza containing a
// space is preserved.
function parseExtractionTitle(title) {
    var s = String(title || '');
    var i = s.indexOf(' : ');
    if (i < 0) return { stanza: s, type: 'EXTRACT', klass: s };
    var stanza = s.slice(0, i);
    var attr = s.slice(i + 3);
    var type = attr.indexOf('REPORT-') === 0 ? 'REPORT' : 'EXTRACT';
    var klass = attr.replace(/^(EXTRACT|REPORT)-/, '');
    return { stanza: stanza, type: type, klass: klass };
}

// Space-separated enabled tag names -> array (the ko_tags_backup `definition`).
function tagNames(definition) {
    return String(definition || '').trim().split(/\s+/).filter(function (x) { return x.length; });
}

// Synthesized lookup definition "type=file, filename=x.csv, fields=a,b,c" ->
// dict. Top-level pairs are ", "-separated; a value (e.g. fields) may contain
// bare commas, so split key/value on the FIRST "=".
function parseLookupDefinition(def) {
    var out = {};
    String(def || '').split(', ').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        if (i < 0) return;
        out[kv.slice(0, i).trim()] = kv.slice(i + 1);
    });
    return out;
}

module.exports = { parseExtractionTitle: parseExtractionTitle, tagNames: tagNames, parseLookupDefinition: parseLookupDefinition };
