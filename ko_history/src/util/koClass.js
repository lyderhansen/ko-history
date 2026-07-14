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

module.exports = {
    RESTORABLE_CLASSES: RESTORABLE_CLASSES,
    canRestoreClass: canRestoreClass
};
