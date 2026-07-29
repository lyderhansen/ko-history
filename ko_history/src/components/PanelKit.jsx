import React from 'react';
import PAL from '../util/palette';
import { tokenizeSpl } from '../shared/splHighlight';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/* Syntax-highlighted SPL. Tokens come from the shared tokenizer that the
 * ko_viewer visualization also uses, so a saved search reads the same way in
 * the record card and here. Colors are palette tokens, so this follows the
 * theme like every other surface.
 *
 * Rendered as spans inside a <pre>, never via dangerouslySetInnerHTML: the SPL
 * is user content pulled from the index, and it must not be able to inject
 * markup into the wrapper. */
const SPL_COLOR = {
    cmd: PAL.splCmd, fn: PAL.splFn, kw: PAL.splKw, str: PAL.splStr, num: PAL.splNum,
};
export function SplCode({ code, style }) {
    const text = code == null || code === '' ? '' : String(code);
    if (!text) return null;
    const lines = text.replace(/\r/g, '').split('\n');
    return (
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, color: PAL.text,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }}>
            {lines.map((line, li) => (
                <div key={li}>
                    {tokenizeSpl(line).map((t, ti) => (
                        t.kind === 'text'
                            ? t.text
                            : <span key={ti} style={{ color: SPL_COLOR[t.kind] }}>{t.text}</span>
                    ))}
                    {/* keep blank lines from collapsing */}
                    {line === '' ? ' ' : null}
                </div>
            ))}
        </pre>
    );
}

/* Indeterminate progress keyframes, injected once. Same idiom the wrapper uses
 * for the spinner: guarded on a style id so a remount can't duplicate it.
 * The animation is opt-in via prefers-reduced-motion, so the reduced-motion
 * default is a static full-width tinted bar rather than an off-screen sliver. */
const PROGRESS_STYLE_ID = 'kohist-progress-kf';
function injectProgressKeyframes() {
    if (typeof document === 'undefined' || document.getElementById(PROGRESS_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = PROGRESS_STYLE_ID;
    s.textContent =
        '@keyframes kohist-progress-slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}' +
        '.kohist-progress{width:100%}' +
        '@media (prefers-reduced-motion: no-preference){' +
        '.kohist-progress{width:40%;animation:kohist-progress-slide 1.1s ease-in-out infinite}}';
    document.head.appendChild(s);
}

/* Thin indeterminate progress bar pinned under the panel header. Visible
 * whenever work is in flight, so a click always produces immediate feedback
 * and a slow search reads as slow rather than broken. */
export function ProgressBar({ active }) {
    injectProgressKeyframes();
    return (
        <div
            role="progressbar"
            aria-hidden={active ? undefined : 'true'}
            aria-label={active ? 'Loading' : undefined}
            style={{ height: 2, marginTop: 8, borderRadius: 1, overflow: 'hidden',
                background: active ? PAL.edgeSoft : 'transparent' }}
        >
            {active ? (
                <div className="kohist-progress" style={{ height: '100%', background: PAL.accent, borderRadius: 1 }} />
            ) : null}
        </div>
    );
}

/* External-link icon: box with arrow leaving it (spec §6). 11px, currentColor. */
export function OpenIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ flex: '0 0 auto', opacity: 0.85 }}>
            <path d="M4.5 2.5H2.2A1.2 1.2 0 0 0 1 3.7v6.1A1.2 1.2 0 0 0 2.2 11h6.1a1.2 1.2 0 0 0 1.2-1.2V7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M7 1h4v4M10.6 1.4 5.8 6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/* Clickable warning flag on the KO card (spec §8). color: PAL.warn or PAL.danger. */
export function Flag({ color, bg, dot, open, onClick, children }) {
    const [hover, setHover] = React.useState(false);
    return (
        <button type="button" onClick={onClick}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
            style={{ background: hover ? bg : 'none', border: 'none', cursor: 'pointer',
                font: 'inherit', fontSize: 11.5, fontWeight: 500, color,
                padding: '2px 4px', borderRadius: 4, display: 'inline-flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}>
            {dot ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flex: '0 0 auto' }} /> : null}
            {children}
            <span style={{ fontSize: 9, color: PAL.text3, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▾</span>
        </button>
    );
}

/* Button that merges a hover style on mouseenter/leave, for the builder-produced
 * button styles (btnPrimary/btnSecondary/btnRestore/btnGhost) that can't express
 * :hover inline (spec's `.btn-*:hover` rules). `base`/`hover` are style objects;
 * hover is suppressed while disabled so a disabled button never looks live. */
export function HoverBtn({ base, hover, disabled, children, ...rest }) {
    const [h, setH] = React.useState(false);
    return (
        <button type="button" disabled={disabled} {...rest}
            onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
            style={h && !disabled ? { ...base, ...hover } : base}>
            {children}
        </button>
    );
}

/* Drawer inside the KO card, below the actions row (spec §8). */
export function Drawer({ open, children }) {
    if (!open) return null;
    return (
        <div style={{ padding: '10px 14px 12px', borderTop: `1px solid ${PAL.edgeSoft}`,
            fontSize: 12.5, color: PAL.text2, lineHeight: 1.55 }}>
            {children}
        </div>
    );
}
/* Bold lead inside a drawer, tinted by tone. */
export function DrawerLead({ tone, children }) {
    return <b style={{ color: tone === 'danger' ? PAL.danger : PAL.warn, fontWeight: 600 }}>{children}</b>;
}

/* One segmented-control tab. Tracks its own hover so the resting/inactive
 * label can lighten on hover (contract: .tab:hover{color:var(--text)}),
 * matching the pattern already used by Flag below. */
function Tab({ label, active, onClick }) {
    const [hover, setHover] = React.useState(false);
    return (
        <button type="button" role="tab" aria-selected={active} onClick={onClick}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
            style={{ flex: 1, textAlign: 'center', font: 'inherit', fontSize: 12.5, fontWeight: 600,
                color: active ? PAL.text : hover ? PAL.text : PAL.text2, padding: '7px 0', borderRadius: 4,
                cursor: 'pointer', border: 'none', transition: 'color .12s',
                background: active ? PAL.panel : 'none',
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.3)' : 'none' }}>
            {label}
        </button>
    );
}

/* Segmented tab control (spec §1). tabs: [{key, label}]. */
export function Tabs({ tabs, active, onSelect }) {
    return (
        <div role="tablist" style={{ display: 'flex', gap: 2, background: PAL.field,
            border: `1px solid ${PAL.edgeSoft}`, borderRadius: 6, padding: 3, margin: '16px 0 0' }}>
            {tabs.map((t) => (
                <Tab key={t.key} label={t.label} active={t.key === active} onClick={() => onSelect(t.key)} />
            ))}
        </div>
    );
}

/* Small segmented control for modal toolbars. Same visual language as Tabs.
 * Each item is [key, label] or [key, label, title] — the optional third
 * element becomes the button's title tooltip. */
export function Seg({ items, active, onSelect }) {
    return (
        <div style={{ display: 'inline-flex', gap: 2, background: PAL.field,
            border: `1px solid ${PAL.edgeSoft}`, borderRadius: 6, padding: 3 }}>
            {items.map(([key, label, title]) => (
                <SegBtn key={key} label={label} title={title} on={key === active} onClick={() => onSelect(key)} />
            ))}
        </div>
    );
}
function SegBtn({ label, title, on, onClick }) {
    const [hover, setHover] = React.useState(false);
    return (
        <button type="button" onClick={onClick} title={title}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
            style={{ border: 'none', background: on ? PAL.panel : 'none',
                color: on ? PAL.text : (hover ? PAL.text : PAL.text2),
                font: 'inherit', fontSize: 12, fontWeight: 600, padding: '5px 14px',
                borderRadius: 4, cursor: 'pointer',
                boxShadow: on ? '0 1px 2px rgba(0,0,0,0.3)' : 'none' }}>
            {label}
        </button>
    );
}

/* Run-cost chip, tinted by level (heavy=danger, moderate=warn, light=quiet).
 * Same mapping the KO card flag uses. */
export function CostFlag({ a, prefix }) {
    if (!a) return null;
    const map = {
        heavy:    { fg: PAL.danger, bg: PAL.dangerBg },
        moderate: { fg: PAL.warn,   bg: PAL.warnBg },
    };
    const c = map[a.level] || { fg: PAL.text2, bg: PAL.panel2 };
    // The time range is the single biggest driver of what a render costs, so it
    // belongs in the chip itself, not only in a tooltip. A dashboard that is
    // "heavy" because its panels run all-time or real-time reads identically to
    // one that is heavy from panel count without it.
    const range = a.range && a.range.label && a.range.label !== 'unknown' ? a.range.label : '';
    const detail = `${a.panels} panel${a.panels === 1 ? '' : 's'} · ${a.searches} search${a.searches === 1 ? '' : 'es'}`
        + (range ? ` · ${range}` : '');
    // Tooltip carries the reasons analyze() actually flagged. `note` alone is
    // not enough: heaviness.js only sets it for token-driven ranges that are
    // neither realtime nor alltime, i.e. it is empty for exactly the worst cases.
    const reasons = a.flags && a.flags.length ? a.flags.join(', ') : '';
    const tip = [reasons, a.note].filter(Boolean).join('. ') || detail;
    return (
        <span title={tip}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
                fontWeight: 500, padding: '2px 8px', borderRadius: 4, color: c.fg, background: c.bg,
                whiteSpace: 'nowrap' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.fg, flex: '0 0 auto' }} />
            {prefix ? prefix + ' · ' : ''}{a.level} · {detail}
        </span>
    );
}

/* One-line quiet notice with icon (spec §9). Default is the info (ⓘ grey)
 * variant; pass `warn` for the caution variant (⚠ in PAL.warn) used by
 * surfaces that genuinely need it, e.g. the approval modal. Pass `inline`
 * when the Notice sits alongside other controls in a horizontal flex row
 * (e.g. a run bar) — it drops the block-level top margin so the caller
 * doesn't need a margin-cancellation wrapper. */
export function Notice({ warn, inline, children }) {
    return (
        <div style={{ display: 'flex', gap: 10, fontSize: 12.5, color: PAL.text2, lineHeight: 1.5, marginTop: inline ? 0 : 12 }}>
            <span aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 1, color: warn ? PAL.warn : PAL.text3, fontSize: 12 }}>
                {warn ? '⚠' : 'ⓘ'}
            </span>
            <span>{children}</span>
        </div>
    );
}

/* select/input that can't express :focus inline — tracks focus itself and
 * swaps to a 1px accent border + 2px accent-alpha ring (spec "Interaction
 * details": Focus). `as`: 'select' | 'input'. Behavior/props pass through
 * untouched; only the rendered style and focus/blur wiring are added. */
export function FocusCtrl({ as, style, onFocus, onBlur, children, ...rest }) {
    const [focused, setFocused] = React.useState(false);
    const Tag = as;
    return (
        <Tag
            {...rest}
            style={{ ...style,
                borderColor: focused ? PAL.accent : style.borderColor,
                boxShadow: focused ? `0 0 0 2px ${PAL.accentBg}` : 'none' }}
            onFocus={(e) => { setFocused(true); if (onFocus) onFocus(e); }}
            onBlur={(e) => { setFocused(false); if (onBlur) onBlur(e); }}
        >
            {children}
        </Tag>
    );
}

/* Hairline definition list, mono right-aligned values (spec §12). rows: [label, node]. */
export function StatsList({ rows }) {
    return (
        <div>
            {rows.map(([k, v], i) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12,
                    padding: '6px 0', borderTop: i === 0 ? 'none' : `1px solid ${PAL.edgeSoft}` }}>
                    <span style={{ color: PAL.text2, fontSize: 12.5 }}>{k}</span>
                    <span style={{ color: PAL.text, fontSize: 12, fontFamily: MONO,
                        fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
                </div>
            ))}
        </div>
    );
}

/* Style factory the wrapper uses for its own elements. */
export function kitStyles() {
    return {
        lbl: { display: 'block', margin: '12px 0 6px', color: PAL.text3, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.1 },
        // Compare/Restore field labels (contract .vrow/.rrow .lbl: margin-bottom
        // only, no top margin — the gap above each field comes from the swap
        // control's own margin, or from fieldLblGap below). Kept separate from
        // `lbl` above so the out-of-scope restore-confirm modal (which still
        // uses `lbl`) is untouched.
        fieldLbl: { display: 'block', margin: '0 0 6px', color: PAL.text3, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.1 },
        // Restore pane's 2nd/3rd field in a group (contract .rrow{gap:12px}
        // reproduced via the label's own top margin since there's no flex
        // wrapper around each field).
        fieldLblGap: { display: 'block', margin: '12px 0 6px', color: PAL.text3, fontSize: 11.5, fontWeight: 600, letterSpacing: 0.1 },
        lblSub: { fontWeight: 400, fontSize: 11, color: PAL.text3 },
        ctrl: { width: '100%', padding: '9px 12px', background: PAL.field, color: PAL.text,
            border: `1px solid ${PAL.edge}`, borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
            transition: 'border-color .12s' },
        btnBase: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '10px 16px',
            border: '1px solid transparent', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' },
        koCard: { background: PAL.panel2, borderRadius: 6, overflow: 'hidden', marginTop: 14 },
        mono: { fontFamily: MONO },
    };
}
export { MONO, PAL };
