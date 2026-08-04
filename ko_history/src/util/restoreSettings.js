/*
 * restoreSettings.js — pure parse/serialize for the [restore] stanza of
 * ko_history.conf, plus the one function that decides whether a restore is
 * permitted.
 *
 * Restore is opt-in. Nothing is restorable until an admin enables it on the
 * KO History settings page, so every failure mode here fails CLOSED: a missing
 * conf, an unreadable response, a malformed payload and an empty stanza all
 * produce an empty allow-list rather than a default of "dashboards and reports".
 *
 * The real gate is effectiveAllowed(), which intersects what the admin enabled
 * with koClass.AVAILABLE_CLASSES. That intersection is why hand-editing
 * local/ko_history.conf cannot switch on a type whose restore has not shipped:
 * the conf key is accepted and stored, and then ignored.
 *
 * No browser dependencies, so Node can require() this for tests.
 */
'use strict';

var koClass = require('./koClass');

// Splunk conf booleans are written many ways. Anything not on this list, and
// anything absent, is off.
function isTrue(v) {
    if (v === true) return true;
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '').toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/*
 * Parse the JSON body of
 *   GET /servicesNS/nobody/ko_history/configs/conf-ko_history/restore
 *
 * Returns { found, enabled, canWrite }:
 *   found    the stanza existed and had a readable content block
 *   enabled  ids the admin has switched on, in ALL_CLASSES order
 *   canWrite the caller may POST changes back, taken from the stanza's own ACL
 *            so no role name is hardcoded anywhere in the app
 *
 * The content block also carries inherited eai:* and default keys; only the
 * seven known class ids are read, so unrelated keys cannot turn anything on.
 */
function parseSettings(body) {
    var out = { found: false, enabled: [], canWrite: false };
    if (!body || typeof body !== 'object') return out;

    var entries = body.entry;
    if (!entries || !entries.length) return out;
    var entry = entries[0];
    if (!entry || typeof entry !== 'object') return out;

    var content = entry.content;
    if (!content || typeof content !== 'object') return out;

    out.found = true;
    out.canWrite = !!(entry.acl && entry.acl.can_write);

    for (var i = 0; i < koClass.ALL_CLASSES.length; i++) {
        var id = koClass.ALL_CLASSES[i].id;
        if (isTrue(content[id])) out.enabled.push(id);
    }
    return out;
}

/*
 * Build the form body for a write. Every known key is written explicitly,
 * including the ones being turned off: posting only the enabled keys would
 * leave a previously enabled type set in local conf.
 *
 * A type whose restore has not shipped is always written as 0, even if it was
 * passed in as enabled. Otherwise a key that someone set by hand (the spec says
 * it has no effect, so people will try it) survives every save, and the day that
 * type moves into AVAILABLE_CLASSES its restore goes live on that instance with
 * nobody having opted in. Writing 0 makes any save clean the stale key up.
 */
function serializeSettings(enabled) {
    var on = {};
    var list = enabled || [];
    for (var i = 0; i < list.length; i++) {
        on[koClass.normClass(list[i])] = true;
    }
    var parts = [];
    for (var j = 0; j < koClass.ALL_CLASSES.length; j++) {
        var id = koClass.ALL_CLASSES[j].id;
        var live = on[id] && koClass.isAvailableClass(id);
        parts.push(encodeURIComponent(id) + '=' + (live ? '1' : '0'));
    }
    return parts.join('&');
}

/*
 * The gate. What the admin enabled, narrowed to what actually ships.
 * Result is in ALL_CLASSES order and deduplicated.
 */
function effectiveAllowed(enabled) {
    var on = {};
    var list = enabled || [];
    for (var i = 0; i < list.length; i++) {
        on[koClass.normClass(list[i])] = true;
    }
    var out = [];
    for (var j = 0; j < koClass.ALL_CLASSES.length; j++) {
        var id = koClass.ALL_CLASSES[j].id;
        if (on[id] && koClass.isAvailableClass(id)) out.push(id);
    }
    return out;
}

// Convenience predicate for a single type against an enabled list.
function isRestoreAllowed(type, enabled) {
    var c = koClass.normClass(type);
    if (!c) return false;
    var allowed = effectiveAllowed(enabled);
    for (var i = 0; i < allowed.length; i++) {
        if (allowed[i] === c) return true;
    }
    return false;
}

/*
 * Why is restore unavailable for this type? Drives the disabled button's
 * tooltip, so an admin is told which of three different problems they have
 * instead of seeing a silently greyed-out control.
 *
 * state: 'ok' | 'error' | 'forbidden' | 'loading' — how the settings fetch went.
 * 'forbidden' is separated out because "reload and try again" is useless advice
 * for a permission problem: reloading fails identically every time.
 */
function restoreBlockReason(type, enabled, state) {
    if (state === 'loading') return 'Checking whether restore is enabled...';
    if (state === 'forbidden') {
        return 'Your account is not allowed to read the KO History settings, so restore is unavailable. An admin needs to grant read access to this app before restore can work for you.';
    }
    if (state === 'error') {
        return 'Restore settings could not be loaded, so restore is unavailable. Reload the page, or check the KO History settings page.';
    }
    var c = koClass.normClass(type);
    if (!c) return 'Select a knowledge object first.';
    if (!koClass.isKnownClass(c)) {
        return 'Restore is not supported for this object type.';
    }
    if (!koClass.isAvailableClass(c)) {
        return 'Restore for ' + koClass.classLabel(c).toLowerCase() +
               ' has not shipped yet. It is listed on the settings page as a placeholder.';
    }
    if (!isRestoreAllowed(c, enabled)) {
        return 'Restore is turned off for ' + koClass.classLabel(c).toLowerCase() +
               '. An admin can enable it on the KO History settings page.';
    }
    return '';
}

module.exports = {
    parseSettings: parseSettings,
    serializeSettings: serializeSettings,
    effectiveAllowed: effectiveAllowed,
    isRestoreAllowed: isRestoreAllowed,
    restoreBlockReason: restoreBlockReason
};
