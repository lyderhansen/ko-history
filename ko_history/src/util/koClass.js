/*
 * koClass.js — the KO types this app knows about, and which of them have a
 * shipped restore implementation.
 *
 * Two separate ideas, deliberately not merged:
 *
 *   ALL_CLASSES       every type KO History captures, compares and displays.
 *   AVAILABLE_CLASSES the subset whose restore code has been tested and shipped.
 *
 * Whether restore is *allowed* is a third thing again: an admin opts in per
 * type in ko_history.conf. See restoreSettings.js, which intersects the two so
 * an untested type cannot be switched on by editing conf alone.
 *
 * No browser dependencies, so Node can require() this for tests.
 */
'use strict';

// Display order for the settings page. Labels are user-facing copy.
var ALL_CLASSES = [
    { id: 'dashboard',       label: 'Dashboards' },
    { id: 'savedsearch',     label: 'Reports and alerts' },
    { id: 'macro',           label: 'Macros' },
    { id: 'eventtype',       label: 'Event types' },
    { id: 'fieldextraction', label: 'Field extractions' },
    { id: 'lookup',          label: 'Lookup definitions' },
    { id: 'tag',             label: 'Tags' }
];

// Restore implementations that have shipped. restoreKO() in splunkRest.js also
// implements the other five, but they have not had a test pass, so they stay
// out of this list and the settings page renders them as placeholders.
// Moving a type in here is the one-line change that makes it enableable.
var AVAILABLE_CLASSES = ['dashboard', 'savedsearch'];

function norm(koClass) {
    return String(koClass == null ? '' : koClass).replace(/^\s+|\s+$/g, '').toLowerCase();
}

// True when this app knows the type at all.
function isKnownClass(koClass) {
    var c = norm(koClass);
    for (var i = 0; i < ALL_CLASSES.length; i++) {
        if (ALL_CLASSES[i].id === c) return true;
    }
    return false;
}

// True when a shipped restore implementation exists for the type. This is NOT
// permission to restore: the admin still has to enable the type. Callers that
// need the real answer must use restoreSettings.effectiveAllowed().
function isAvailableClass(koClass) {
    var c = norm(koClass);
    for (var i = 0; i < AVAILABLE_CLASSES.length; i++) {
        if (AVAILABLE_CLASSES[i] === c) return true;
    }
    return false;
}

// Human label for a type id, falling back to the id itself.
function classLabel(koClass) {
    var c = norm(koClass);
    for (var i = 0; i < ALL_CLASSES.length; i++) {
        if (ALL_CLASSES[i].id === c) return ALL_CLASSES[i].label;
    }
    return String(koClass == null ? '' : koClass);
}

module.exports = {
    ALL_CLASSES: ALL_CLASSES,
    AVAILABLE_CLASSES: AVAILABLE_CLASSES,
    normClass: norm,
    isKnownClass: isKnownClass,
    isAvailableClass: isAvailableClass,
    classLabel: classLabel
};
