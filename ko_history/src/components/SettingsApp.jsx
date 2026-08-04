/*
 * SettingsApp.jsx — the KO History admin settings page (view: ko_settings).
 *
 * Deliberately its own page rather than a panel inside the wrapper: this is set
 * once by an admin, not touched during an investigation. Reached from the app
 * nav only. There is no setup_view: it needs is_configured = false, and that
 * pair redirects every user to setup until it is saved, which strands the
 * non-admins who get this page read-only.
 *
 * Today it configures one thing, restore. The page is laid out as a list of
 * sections so a second setting does not require a redesign.
 *
 * Read-only mode is driven by the conf stanza's own ACL (see
 * splunkRest.readRestoreSettings), never by testing role names.
 */
import React from 'react';

import { ALL_CLASSES, isAvailableClass } from '../util/koClass';
import { serializeSettings } from '../util/restoreSettings';
import { readRestoreSettings, writeRestoreSettings } from '../util/splunkRest';
import { HoverBtn, Notice, kitStyles, PAL } from './PanelKit';

const S = kitStyles();

// Two allow-lists are equal when they serialize identically; order and case
// differences in state should not light up the Save button.
function same(a, b) {
    return serializeSettings(a) === serializeSettings(b);
}

function Pill({ tone, children }) {
    const c = tone === 'soon'
        ? { fg: PAL.text3, bg: PAL.panel2 }
        : { fg: PAL.restoreText, bg: PAL.restoreBg };
    return (
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            color: c.fg, background: c.bg, whiteSpace: 'nowrap', flex: '0 0 auto' }}>
            {children}
        </span>
    );
}

/* One KO type row. `available` false renders the placeholder state: visible so
 * the roadmap is legible, disabled so it cannot be switched on. */
function TypeRow({ type, checked, available, locked, onToggle }) {
    const disabled = !available || locked;
    const [hover, setHover] = React.useState(false);
    return (
        <label
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                borderTop: `1px solid ${PAL.edgeSoft}`, cursor: disabled ? 'default' : 'pointer',
                background: hover && !disabled ? PAL.panel2 : 'transparent',
                transition: 'background .12s' }}>
            <input
                type="checkbox"
                checked={!!checked}
                disabled={disabled}
                onChange={() => onToggle(type.id)}
                style={{ width: 15, height: 15, flex: '0 0 auto', accentColor: PAL.accent,
                    cursor: disabled ? 'default' : 'pointer' }}
            />
            <span style={{ flex: '1 1 auto', fontSize: 13,
                color: available ? PAL.text : PAL.text3 }}>
                {type.label}
            </span>
            {!available && <Pill tone="soon">Not yet available</Pill>}
            {available && checked && <Pill>Enabled</Pill>}
        </label>
    );
}

function Section({ title, children }) {
    return (
        <section style={{ background: PAL.panel, border: `1px solid ${PAL.edgeSoft}`,
            borderRadius: 8, overflow: 'hidden', marginTop: 18 }}>
            <h2 style={{ margin: 0, padding: '14px 16px 12px', fontSize: 14, fontWeight: 600,
                color: PAL.text, borderBottom: `1px solid ${PAL.edgeSoft}` }}>
                {title}
            </h2>
            {children}
        </section>
    );
}

export default function SettingsApp() {
    // 'loading' | 'ready' | 'error'
    const [state, setState] = React.useState('loading');
    const [loadError, setLoadError] = React.useState('');
    const [missing, setMissing] = React.useState(false);
    const [canWrite, setCanWrite] = React.useState(false);
    const [saved, setSaved] = React.useState([]);      // what is on disk
    const [draft, setDraft] = React.useState([]);      // what the admin has picked
    const [busy, setBusy] = React.useState(false);
    const [saveError, setSaveError] = React.useState('');
    const [justSaved, setJustSaved] = React.useState(false);
    // Saved, but the confirming re-read failed, so what is shown is what we
    // asked for rather than what was read back.
    const [unconfirmed, setUnconfirmed] = React.useState(false);

    const apply = React.useCallback((res) => {
        // Narrow to types that actually ship. A conf key someone set by hand for
        // an unshipped type would otherwise render as a ticked row that is also
        // disabled and labelled "Not yet available", which the admin can neither
        // explain nor untick. serializeSettings writes those keys as 0, so the
        // next save clears them.
        const shown = (res.enabled || []).filter(isAvailableClass);
        setSaved(shown);
        setDraft(shown);
        setCanWrite(!!res.canWrite);
        setMissing(!!res.missing);
        setState('ready');
    }, []);

    React.useEffect(() => {
        let live = true;
        readRestoreSettings()
            .then((res) => { if (live) apply(res); })
            .catch((e) => {
                if (!live) return;
                const code = e && e.code;
                setLoadError(
                    code === 'FORBIDDEN'
                        ? 'Your account is not allowed to read the KO History settings. Restore stays unavailable for you until that changes.'
                        : code === 'TIMEOUT'
                            ? 'The settings did not load within 30 seconds. Splunk may be busy. Reload to try again.'
                            : 'The settings could not be read from ko_history.conf.'
                );
                setState('error');
            });
        return () => { live = false; };
    }, [apply]);

    const toggle = (id) => {
        setJustSaved(false);
        setSaveError('');
        setDraft((cur) => (cur.indexOf(id) >= 0
            ? cur.filter((c) => c !== id)
            : cur.concat([id])));
    };

    const save = () => {
        setBusy(true);
        setSaveError('');
        setJustSaved(false);
        setUnconfirmed(false);
        writeRestoreSettings(draft)
            .then((res) => {
                apply(res);
                setJustSaved(true);
                // The write landed but the confirming re-read did not. Saying
                // "could not be saved" here would state the opposite of what is
                // now on disk, and restore may already be live for everyone.
                setUnconfirmed(res.confirmed === false);
            })
            .catch((e) => {
                const code = e && e.code;
                setSaveError(
                    code === 'FORBIDDEN'
                        ? 'Saving was refused. Your account can no longer write the configuration of this app.'
                        : code === 'TIMEOUT'
                            ? 'Saving timed out after 30 seconds. The settings may or may not have been written. Reload this page to see the current state before trying again.'
                            : 'The settings could not be saved. ' + ((e && e.message) || '')
                );
            })
            .then(() => setBusy(false));
    };

    const dirty = !same(draft, saved);
    const locked = !canWrite || busy;
    const anyOn = ALL_CLASSES.some((t) => isAvailableClass(t.id) && draft.indexOf(t.id) >= 0);

    const page = (body) => (
        <div style={{ minHeight: '100vh', background: PAL.bg, color: PAL.text,
            fontFamily: 'Splunk Platform Sans, Roboto, Helvetica Neue, Arial, sans-serif',
            padding: '28px 20px 60px' }}>
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
                <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: PAL.text }}>
                    KO History settings
                </h1>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: PAL.text2, lineHeight: 1.55 }}>
                    Applies to every user of this app on this instance.
                </p>
                {body}
            </div>
        </div>
    );

    if (state === 'loading') {
        return page(
            <Section title="Restore">
                <div style={{ padding: '16px' }}>
                    <span style={{ fontSize: 13, color: PAL.text2 }}>Loading settings...</span>
                </div>
            </Section>
        );
    }

    if (state === 'error') {
        return page(
            <Section title="Restore">
                <div style={{ padding: '14px 16px 16px' }}>
                    <Notice warn>{loadError}</Notice>
                    <Notice>
                        Restore stays unavailable while the settings cannot be read, so nothing
                        can be written back into your environment in the meantime.
                    </Notice>
                </div>
            </Section>
        );
    }

    return page(
        <Section title="Restore">
            <div style={{ padding: '14px 16px 4px' }}>
                <p style={{ margin: 0, fontSize: 13, color: PAL.text2, lineHeight: 1.6 }}>
                    Restore writes a captured version back into a real knowledge object, in
                    whichever app the user selects. It is the only operation in KO History that
                    changes your environment, so it is off until you turn it on.
                </p>
                <Notice>
                    Capture, version history, preview and compare are unaffected by these
                    settings and keep working with everything below switched off.
                </Notice>
                {!canWrite && (
                    <Notice warn>
                        You can see these settings but not change them. Writing them needs the
                        admin or sc_admin role.
                    </Notice>
                )}
                {missing && (
                    <Notice warn>
                        No restore settings were found in ko_history.conf, so every type is
                        treated as off.
                        {canWrite
                            ? ' Saving this page will create them.'
                            : ' Creating them needs the admin or sc_admin role.'}
                    </Notice>
                )}
            </div>

            <div style={{ margin: '10px 0 0' }}>
                {ALL_CLASSES.map((t) => (
                    <TypeRow
                        key={t.id}
                        type={t}
                        checked={draft.indexOf(t.id) >= 0}
                        available={isAvailableClass(t.id)}
                        locked={locked}
                        onToggle={toggle}
                    />
                ))}
            </div>

            <div style={{ padding: '12px 16px 16px', borderTop: `1px solid ${PAL.edgeSoft}` }}>
                <Notice>
                    The greyed-out types are captured and can be compared today. Their restore is
                    written but has not finished testing, so it is not offered yet.
                </Notice>

                {canWrite && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                        <HoverBtn
                            base={{ ...S.btnBase, width: 'auto',
                                background: dirty ? PAL.primaryBtn : PAL.panel2,
                                color: dirty ? PAL.primaryBtnText : PAL.text3,
                                cursor: dirty && !busy ? 'pointer' : 'default' }}
                            hover={{ background: PAL.primaryBtnHover }}
                            disabled={!dirty || busy}
                            onClick={save}>
                            {busy ? 'Saving...' : 'Save'}
                        </HoverBtn>
                        <HoverBtn
                            base={{ ...S.btnBase, width: 'auto', background: 'transparent',
                                color: dirty ? PAL.text2 : PAL.text3, borderColor: PAL.edge,
                                cursor: dirty && !busy ? 'pointer' : 'default' }}
                            hover={{ color: PAL.text, borderColor: PAL.edge }}
                            disabled={!dirty || busy}
                            onClick={() => { setDraft(saved); setSaveError(''); setJustSaved(false); setUnconfirmed(false); }}>
                            Discard changes
                        </HoverBtn>
                        {justSaved && !dirty && !unconfirmed && (
                            <span style={{ fontSize: 12.5, color: PAL.diffAdded }}>
                                Saved. {anyOn ? 'Restore is now available for the types above.' : 'Restore is now off for every type.'}
                            </span>
                        )}
                    </div>
                )}

                {justSaved && unconfirmed && (
                    <Notice warn>
                        Saved, but reading the settings back failed, so this page is showing what
                        was sent rather than what is on disk. The change has almost certainly
                        taken effect. Reload to confirm.
                    </Notice>
                )}

                {saveError && <Notice warn>{saveError}</Notice>}

                {!anyOn && !dirty && (
                    <Notice>
                        Restore is currently disabled for every type. The Restore buttons in the
                        app stay greyed out and explain why when hovered.
                    </Notice>
                )}
            </div>
        </Section>
    );
}
