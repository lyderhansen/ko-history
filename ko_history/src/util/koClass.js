/*
 * koClass.js — pure helpers for KO-type restore gating (v1.0).
 *
 * v1.0 ships restore for dashboards and reports (saved searches) only; the
 * other five KO types are captured/audited/viewable but not yet restorable.
 * No browser dependencies, so Node can require() this for tests.
 */
'use strict';

var RESTORABLE_CLASSES = ['dashboard', 'savedsearch'];

function norm(koClass) {
    return String(koClass == null ? '' : koClass).replace(/^\s+|\s+$/g, '').toLowerCase();
}

// True only for the KO classes whose restore ships in v1.0.
function canRestoreClass(koClass) {
    var c = norm(koClass);
    for (var i = 0; i < RESTORABLE_CLASSES.length; i++) {
        if (RESTORABLE_CLASSES[i] === c) return true;
    }
    return false;
}

// Human label for the "coming soon" affordance.
var LABELS = {
    macro: 'Macro', eventtype: 'Event type', fieldextraction: 'Field extraction',
    extraction: 'Field extraction', lookup: 'Lookup', tag: 'Tag',
    dashboard: 'Dashboard', savedsearch: 'Saved search'
};
function comingSoonLabel(koClass) {
    var c = norm(koClass);
    return LABELS[c] || (c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Object');
}

module.exports = {
    RESTORABLE_CLASSES: RESTORABLE_CLASSES,
    canRestoreClass: canRestoreClass,
    comingSoonLabel: comingSoonLabel
};
