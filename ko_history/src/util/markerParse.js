/*
 * Parser for the selection marker the ko_version_ds dashboard renders and the
 * React wrapper reads.
 *
 * This is the single most breakage-prone contract in the app: an invisible
 * markdown panel inside an iframe, read as text, whose shape is defined in one
 * repo (the DS generator) and consumed in another (the wrapper). It lived
 * inline in WrapperApp.jsx with no tests until a marker with an empty trailing
 * field was found not to parse at all.
 *
 * Wire format, emitted by the `viz_link` panel:
 *
 *     kohist-sel: <title> ⟪|⟫ <app> ⟪|⟫ <ko_class> ⟪|⟫ <epoch>
 *
 * The ⟪|⟫ delimiter is deliberately exotic: a plain "|" would collide with SPL
 * and with KO names. The panel is rendered with a transparent font colour, so
 * it is invisible on screen but present in textContent.
 *
 * CommonJS to match the other node-tested utils; webpack imports it from ESM.
 */

// The FOURTH field is intentionally `(.*?)` rather than `(.+?)`.
//
// `time` defaults to an empty string in the dashboard, and the main KO table's
// drilldown sets link_title/link_app/ko_class but NOT time: only the version
// list sets it. So every first click on a knowledge object emits a marker whose
// epoch field is empty. Requiring a character there made that marker fail to
// parse, the wrapper ignored the selection, and the user had to click a second
// time (after picking a version) before anything happened.
var MARKER_RE = /kohist-sel:\s*(.+?)\s*⟪\|⟫\s*(.+?)\s*⟪\|⟫\s*(.+?)\s*⟪\|⟫\s*(.*?)\s*(?:\n|$)/;

// Pre-0.1.103 dashboards emitted a labelled, human-readable line. Kept so a
// stale dashboard XML works against a new wrapper during a partial upgrade.
// The trailing label was renamed baseline: to previous: in 0.1.84.
var LEGACY_RE = /Selected:\s*(.+?)\s*⟪\|⟫\s*app:\s*(.+?)\s*(?:⟪\|⟫\s*type:\s*(.+?)\s*)?⟪\|⟫\s*(?:baseline|previous):\s*(.*?)\s*(?:\n|$)/;

// A token the dashboard has not resolved yet, or the neutral placeholder it
// seeds before anything is selected. Both dash glyphs are accepted on purpose:
// the generator emits an en dash since the copy sweep, but a dashboard
// generated before it still emits an em dash, and this guard is what stops the
// wrapper selecting a knowledge object named after the glyph.
function isUnsetToken(v) {
    return !v || v.indexOf('$') !== -1 || v === '–' || v === '—';
}

/*
 * Returns { title, appName, koClass, baseEpoch } or null when the text carries
 * no usable selection. baseEpoch is a digit string, or null when no version has
 * been picked yet.
 */
function parseMarker(text) {
    var txt = text == null ? '' : String(text);
    var m = txt.match(MARKER_RE) || txt.match(LEGACY_RE);
    if (!m) return null;

    var title = (m[1] || '').trim();
    var app = (m[2] || '').trim();
    if (isUnsetToken(title) || isUnsetToken(app)) return null;

    var koClass = (m[3] || 'dashboard').trim();
    if (!koClass || koClass.charAt(0) === '$') koClass = 'dashboard';

    // Epoch is integer seconds. Strip anything else: markdown decorators have
    // leaked stray characters into this field before, and an unresolved token
    // arrives here as the literal "$time$".
    var digits = (m[4] || '').trim().replace(/[^\d]/g, '');

    return {
        title: title,
        appName: app,
        koClass: koClass,
        baseEpoch: digits ? digits : null,
    };
}

module.exports = { parseMarker: parseMarker, isUnsetToken: isUnsetToken };
