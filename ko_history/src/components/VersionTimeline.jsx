import React from 'react';
import { parseSchematic, diffSchematic } from '../util/schematic';

/*
 * VersionTimeline — the north-star feature, "Time Machine" style. Versions are a
 * receding 3D stack of cards (newest/focused in front, older receding into the
 * distance) beside a date ruler; scrub or Play to fly through them. Each card is
 * the version's STRUCTURE rendered from its stored source (schematic.js) with
 * per-panel viz-type glyphs — no searches run, so it's instant. The focused card
 * colours panels by what changed vs the previous version (added/moved/removed/
 * retitled). See [[version-timeline-slider-ambition]].
 *
 * Props: versions (newest→oldest, as produced by WrapperApp's `| sort - epoch`),
 *        each {_time, method, xml}. fmtTime(epoch)->str.
 *
 * Internally the array is reversed into a `frames` (oldest→newest) local copy
 * so that Play steps chronologically forward and prev/cur diffs are in the
 * correct direction (prev = one step earlier in time).
 */

const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const DEPTH = 7;          // how many older cards to show receding behind the focused one
const GLYPH_DEPTH = 1;    // cards within this depth get detailed viz glyphs; deeper = plain boxes

const STATUS = {
    added: { bd: '#46aa5a', bg: 'rgba(70,170,90,0.20)', label: 'added' },
    moved: { bd: '#d6b35a', bg: 'rgba(214,179,90,0.16)', label: 'moved / resized' },
    retitled: { bd: '#5ca5d6', bg: 'rgba(92,165,214,0.16)', label: 'retitled' },
    same: { bd: 'rgba(255,255,255,0.22)', bg: 'rgba(255,255,255,0.05)', label: 'unchanged' },
    removed: { bd: '#e0505a', bg: 'rgba(224,80,90,0.12)', label: 'removed' },
};

const STYLE_ID = 'kovt-style';
const CSS = `
.kovt__stage{position:absolute;inset:0;overflow:hidden;perspective:1600px;
 background:radial-gradient(120% 90% at 50% 12%, #1b2733 0%, #0b0f15 55%, #05070a 100%);}
.kovt__stars{position:absolute;inset:0;opacity:.5;
 background-image:radial-gradient(rgba(255,255,255,.5) .6px, transparent .6px),radial-gradient(rgba(255,255,255,.3) .5px, transparent .5px);
 background-size:140px 140px,90px 90px;background-position:0 0,40px 70px;}
.kovt__card{position:absolute;left:50%;bottom:6%;border-radius:9px;overflow:hidden;
 background:#0e131a;border:1px solid rgba(255,255,255,.16);
 box-shadow:0 -6px 30px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.5);
 transition:transform .55s cubic-bezier(.33,.1,.25,1),opacity .55s,filter .55s;
 transform-origin:bottom center;will-change:transform,opacity;}
.kovt__cardbar{height:22px;display:flex;align-items:center;padding:0 10px;
 background:linear-gradient(#222c38,#19222c);border-bottom:1px solid rgba(0,0,0,.4);
 font:600 11px ${SANS};color:#cdd6df;white-space:nowrap;}
.kovt__body{position:absolute;left:0;right:0;top:22px;bottom:0;background:#0b0c10;}
.kovt__pan{position:absolute;box-sizing:border-box;border-radius:4px;border:1px solid;overflow:hidden;
 display:flex;flex-direction:column;
 transition:left .55s,top .55s,width .55s,height .55s,background .35s,border-color .35s;}
.kovt__pan--added{animation:kovtPop .5s ease;}
.kovt__pan--removed{border-style:dashed;}
@keyframes kovtPop{from{transform:scale(.6);opacity:0;}to{transform:scale(1);opacity:1;}}
.kovt__pttl{font:600 11px ${SANS};color:#e9edf1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:4px 6px 0;flex:0 0 auto;}
.kovt__gwrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;}
.kovt__gwrap svg{display:block;}
.kovt__gwrap--fill svg{width:100%;height:100%;}
.kovt__gwrap--icon svg{height:54px;width:auto;max-width:88%;max-height:88%;}
.kovt__ruler{position:absolute;top:0;right:0;width:120px;height:100%;pointer-events:none;
 font:11px ${SANS};color:#9aa9b6;}
.kovt__tick{position:absolute;right:8px;display:flex;align-items:center;gap:8px;transform:translateY(-50%);pointer-events:auto;cursor:pointer;}
.kovt__tick i{display:inline-block;height:1px;background:rgba(255,255,255,.35);}
.kovt__tick--on{color:#fff;font-weight:700;}
.kovt__tick--on i{background:#4fa7d6;height:2px;}
.kovt__chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:10px;font-size:11px;border:1px solid;}
`;

function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

// normalize a viz type to a glyph family
function glyphKind(type) {
    const t = String(type || '').toLowerCase().split('.')[0].split(':')[0];
    if (/single|kpi|number|gauge|radial/.test(t)) return 'single';
    if (/bar|column/.test(t)) return 'bar';
    if (/line|area|spark/.test(t)) return 'line';
    if (/pie|donut/.test(t)) return 'pie';
    if (/table|events|list/.test(t)) return 'table';
    if (/map|choropleth|marker|geo/.test(t)) return 'map';
    if (/markdown|html|text|image|rectangle|ellipse/.test(t)) return 'text';
    if (/input/.test(t)) return 'input';
    return 'generic';
}

// a tiny SVG mock of the viz type, drawn into the panel body. Only chart-like
// glyphs (bar/line/area/table) fill-stretch; icon-like glyphs keep their aspect
// ratio and stay centered (else a map blob stretches into a "cloud").
function Glyph({ kind }) {
    const stroke = 'rgba(180,196,210,0.7)';
    const fill = 'rgba(120,160,200,0.22)';
    const acc = 'rgba(120,170,220,0.55)';
    const vh = 60;
    const fillStretch = kind === 'bar' || kind === 'line' || kind === 'table' || kind === 'text';
    const common = { viewBox: '0 0 100 60', preserveAspectRatio: fillStretch ? 'none' : 'xMidYMid meet' };
    if (kind === 'single') {
        return (
            <svg {...common}><text x="50" y="40" textAnchor="middle" fontSize="26" fontWeight="700" fill={acc} fontFamily={SANS}>###</text></svg>
        );
    }
    if (kind === 'bar') {
        const bars = [18, 34, 26, 46, 38, 52];
        return (
            <svg {...common}>{bars.map((b, i) => <rect key={i} x={6 + i * 15.5} y={vh - b} width="11" height={b} fill={fill} stroke={acc} strokeWidth="0.6" />)}</svg>
        );
    }
    if (kind === 'line') {
        return (
            <svg {...common}>
                <polyline points="2,46 20,30 36,38 54,16 72,24 98,8" fill="none" stroke={acc} strokeWidth="2" />
                <polygon points="2,46 20,30 36,38 54,16 72,24 98,8 98,58 2,58" fill={fill} stroke="none" />
            </svg>
        );
    }
    if (kind === 'pie') {
        return (
            <svg {...common}><circle cx="50" cy="30" r="22" fill={fill} stroke={acc} strokeWidth="1.2" /><path d="M50 30 L50 8 A22 22 0 0 1 70 38 Z" fill={acc} opacity="0.6" /></svg>
        );
    }
    if (kind === 'table') {
        return (
            <svg {...common}>
                <rect x="2" y="4" width="96" height="10" fill="rgba(120,160,200,0.3)" />
                {[18, 28, 38, 48].map((y) => <line key={y} x1="2" y1={y} x2="98" y2={y} stroke={stroke} strokeWidth="0.6" />)}
                <line x1="40" y1="4" x2="40" y2="52" stroke={stroke} strokeWidth="0.5" />
                <line x1="70" y1="4" x2="70" y2="52" stroke={stroke} strokeWidth="0.5" />
            </svg>
        );
    }
    if (kind === 'map') {
        // location pin (kept aspect-correct so it never stretches into a cloud)
        return (
            <svg {...common}>
                <path d="M50 8 C40 8 32 16 32 26 C32 39 50 52 50 52 C50 52 68 39 68 26 C68 16 60 8 50 8 Z" fill={fill} stroke={acc} strokeWidth="2.2" />
                <circle cx="50" cy="25" r="6" fill={acc} />
            </svg>
        );
    }
    if (kind === 'input') {
        return (
            <svg {...common}><rect x="6" y="20" width="88" height="20" rx="10" fill="rgba(255,255,255,0.06)" stroke={stroke} strokeWidth="1" /><path d="M82 27 l5 6 l5 -6" fill="none" stroke={acc} strokeWidth="1.6" /></svg>
        );
    }
    if (kind === 'text') {
        return (
            <svg {...common}>{[14, 24, 34, 44].map((y, i) => <rect key={y} x="6" y={y} width={i % 2 ? 64 : 86} height="4" rx="2" fill={stroke} opacity="0.5" />)}</svg>
        );
    }
    return <svg {...common}><rect x="3" y="3" width="94" height="54" fill="none" stroke={stroke} strokeWidth="0.8" strokeDasharray="4 3" /></svg>;
}

// one version rendered as a dashboard "window" card
function Card({ frame, scale, label, color, detailed, diff, showRemoved }) {
    const s = Math.min(scale.w / frame.canvasW, scale.h / frame.canvasH);
    const panels = frame.panels;
    return (
        <React.Fragment>
            <div className="kovt__cardbar">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            </div>
            <div className="kovt__body">
                <div style={{ position: 'absolute', left: (scale.w - frame.canvasW * s) / 2, top: 8, width: frame.canvasW, height: frame.canvasH, transform: `scale(${s})`, transformOrigin: 'top left' }}>
                    {showRemoved && diff ? diff.removed.map((p) => (
                        <div key={'rm:' + p.id} className="kovt__pan kovt__pan--removed" style={{ left: p.x, top: p.y, width: p.w, height: p.h, borderColor: STATUS.removed.bd, background: STATUS.removed.bg, opacity: 0.5 }}>
                            <div className="kovt__pttl" style={{ color: STATUS.removed.bd, textDecoration: 'line-through' }}>{p.title}</div>
                        </div>
                    )) : null}
                    {panels.map((p) => {
                        const st = diff ? (diff.status[p.id] || 'same') : 'same';
                        const col = color ? STATUS[st] : STATUS.same;
                        const kind = glyphKind(p.type);
                        const showTitle = !/^viz_|^p\d+$/.test(p.title);
                        return (
                            <div key={p.id} className={'kovt__pan' + (st === 'added' && color ? ' kovt__pan--added' : '')}
                                style={{ left: p.x, top: p.y, width: p.w, height: p.h, borderColor: col.bd, background: col.bg }}
                                title={p.title + (p.type ? ' · ' + p.type : '')}>
                                {showTitle ? <div className="kovt__pttl">{p.title}</div> : null}
                                {detailed ? (
                                    <div className={'kovt__gwrap ' + (kind === 'bar' || kind === 'line' || kind === 'table' || kind === 'text' ? 'kovt__gwrap--fill' : 'kovt__gwrap--icon')}>
                                        <Glyph kind={kind} />
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                    {!panels.length ? (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5a636e', fontSize: 13 }}>no parseable panels</div>
                    ) : null}
                </div>
            </div>
        </React.Fragment>
    );
}

export default function VersionTimeline({ versions, fmtTime }) {
    injectStyle();
    // Reverse the incoming newest-first array into oldest-first so that Play
    // steps chronologically forward (idx 0 = oldest, idx n-1 = newest) and
    // prev = frames[idx-1] is always an earlier snapshot than cur.
    const versionsOldFirst = React.useMemo(() => [...versions].reverse(), [versions]);
    const n = versionsOldFirst.length;
    const frames = React.useMemo(() => versionsOldFirst.map((v) => parseSchematic(v.xml)), [versionsOldFirst]);
    const [idx, setIdx] = React.useState(Math.max(0, n - 1));
    const [playing, setPlaying] = React.useState(false);
    const [showRemoved, setShowRemoved] = React.useState(true);

    React.useEffect(() => { setIdx(Math.max(0, n - 1)); setPlaying(false); }, [n]);
    React.useEffect(() => {
        if (!playing) return undefined;
        if (idx >= n - 1) { setPlaying(false); return undefined; }
        const t = setTimeout(() => setIdx((i) => Math.min(n - 1, i + 1)), 1500);
        return () => clearTimeout(t);
    }, [playing, idx, n]);

    const cur = frames[idx] || { canvasW: 1280, canvasH: 720, panels: [] };
    const prev = idx > 0 ? frames[idx - 1] : null;
    const d = React.useMemo(() => diffSchematic(prev, cur), [prev, cur]);

    const stageRef = React.useRef(null);
    const [vp, setVp] = React.useState({ w: 1000, h: 560 });
    React.useEffect(() => {
        const measure = () => { const el = stageRef.current; if (el) setVp({ w: el.clientWidth, h: el.clientHeight }); };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    // scroll wheel steps through versions (up = older, down = newer). Attached
    // natively so we can preventDefault (React's onWheel is passive).
    React.useEffect(() => {
        const el = stageRef.current;
        if (!el) return undefined;
        let acc = 0;
        const TH = 36;
        const onWheel = (e) => {
            e.preventDefault();
            setPlaying(false);
            acc += e.deltaY;
            while (acc >= TH) { acc -= TH; setIdx((i) => Math.min(n - 1, i + 1)); }
            while (acc <= -TH) { acc += TH; setIdx((i) => Math.max(0, i - 1)); }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [n]);

    // front card size: compact, preserve the focused version's aspect
    const cardW = Math.min(vp.w - 220, 560);
    const cardAspect = cur.canvasH / cur.canvasW || 0.6;
    const cardH = Math.min(Math.max(vp.h * 0.5, 220), cardW * cardAspect, vp.h * 0.66);
    const scaleBox = { w: cardW, h: cardH };

    const ver = versionsOldFirst[idx] || {};
    const btn = (bg) => ({ background: bg, color: '#fff', border: 0, borderRadius: 5, padding: '7px 12px', fontSize: 13, cursor: 'pointer', fontFamily: SANS });
    const chip = (s) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 10, fontSize: 11, border: '1px solid', color: STATUS[s].bd, borderColor: STATUS[s].bd, background: STATUS[s].bg });
    const atStart = idx <= 0, atEnd = idx >= n - 1;

    // which cards to draw: focused (depth 0) + up to DEPTH older ones behind it
    const stack = [];
    for (let depth = Math.min(DEPTH, idx); depth >= 0; depth--) {
        const i = idx - depth;
        const sc = 1 - depth * 0.06;
        const ty = -depth * (cardH * 0.085 + 16);
        stack.push({ i, depth, transform: `translateX(-50%) translateY(${ty}px) scale(${sc})`, opacity: Math.max(0.18, 1 - depth * 0.13), z: 1000 - depth, blur: depth > 0 ? Math.min(2.4, depth * 0.5) : 0 });
    }

    // date ruler ticks (sample if many)
    const tickEls = [];
    const maxTicks = 14;
    const stepT = Math.max(1, Math.ceil(n / maxTicks));
    for (let i = 0; i < n; i++) {
        const isOn = i === idx;
        if (!isOn && i % stepT !== 0 && i !== n - 1 && i !== 0) continue;
        const topPct = n > 1 ? (1 - i / (n - 1)) * 92 + 4 : 50; // newest (i=n-1) at bottom
        tickEls.push(
            <div key={i} className={'kovt__tick' + (isOn ? ' kovt__tick--on' : '')} style={{ top: topPct + '%' }} onClick={() => { setPlaying(false); setIdx(i); }}>
                <span style={{ whiteSpace: 'nowrap' }}>{fmtTime ? fmtTime(versionsOldFirst[i]._time).slice(0, 10) : ''}</span>
                <i style={{ width: isOn ? 22 : 12 }} />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, fontFamily: SANS, color: '#e6e6e6' }}>
            {/* controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#0e1116', borderBottom: '1px solid rgba(255,255,255,0.1)', flexWrap: 'wrap' }}>
                <button type="button" style={btn('#1a7a3f')} onClick={() => { if (atEnd) setIdx(0); setPlaying((p) => !p); }}>
                    {playing ? '⏸ Pause' : (atEnd ? '↻ Replay' : '▶ Play')}
                </button>
                <button type="button" style={btn('#2a2d31')} disabled={atStart} onClick={() => setIdx((i) => Math.max(0, i - 1))}>◀</button>
                <input type="range" min={0} max={Math.max(0, n - 1)} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} style={{ flex: 1, minWidth: 160, accentColor: '#4fa7d6' }} />
                <button type="button" style={btn('#2a2d31')} disabled={atEnd} onClick={() => setIdx((i) => Math.min(n - 1, i + 1))}>▶</button>
                <div style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: 13 }}>
                    <b>v{idx + 1}</b>/{n} · {fmtTime ? fmtTime(ver._time) : ''} <span style={{ color: '#9aa0a6' }}>· {ver.method || '–'}</span>
                </div>
            </div>

            {/* change caption */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: '#11151a', borderBottom: '1px solid rgba(255,255,255,0.08)', flexWrap: 'wrap', minHeight: 18 }}>
                {!prev ? (
                    <span style={{ color: '#9aa0a6', fontSize: 12 }}>Initial captured version · {cur.panels.length} panel{cur.panels.length === 1 ? '' : 's'} · {cur.format}</span>
                ) : (
                    <React.Fragment>
                        <span style={{ color: '#9aa0a6', fontSize: 12 }}>changes vs previous:</span>
                        {d.counts.added ? <span style={chip('added')}>+{d.counts.added} added</span> : null}
                        {d.counts.removed ? <span style={chip('removed')}>−{d.counts.removed} removed</span> : null}
                        {d.counts.moved ? <span style={chip('moved')}>{d.counts.moved} moved</span> : null}
                        {d.counts.retitled ? <span style={chip('retitled')}>{d.counts.retitled} retitled</span> : null}
                        {!d.counts.added && !d.counts.removed && !d.counts.moved && !d.counts.retitled ? (
                            <span style={{ color: '#6b7177', fontSize: 12 }}>no structural change (content / search edits only)</span>
                        ) : null}
                        <span style={{ flex: 1 }} />
                        <label style={{ fontSize: 11, color: '#9aa0a6', display: 'inline-flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> ghost removed
                        </label>
                    </React.Fragment>
                )}
            </div>

            {/* time-machine stage */}
            <div ref={stageRef} className="kovt__stage" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <div className="kovt__stars" />
                {stack.map((c) => (
                    <div key={c.i} className="kovt__card" style={{ width: cardW, height: cardH, transform: c.transform, opacity: c.opacity, zIndex: c.z, filter: c.blur ? `blur(${c.blur}px)` : 'none' }}>
                        <Card
                            frame={frames[c.i]}
                            scale={scaleBox}
                            label={`${fmtTime ? fmtTime(versionsOldFirst[c.i]._time) : ''} · ${versionsOldFirst[c.i].method || '–'}`}
                            color={c.depth === 0}
                            detailed={c.depth <= GLYPH_DEPTH}
                            diff={c.depth === 0 ? d : null}
                            showRemoved={c.depth === 0 && showRemoved}
                        />
                    </div>
                ))}
                <div className="kovt__ruler">{tickEls}</div>
            </div>

            {/* legend */}
            <div style={{ display: 'flex', gap: 14, padding: '6px 14px', background: '#0e1116', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: 11, color: '#9aa0a6', flexWrap: 'wrap' }}>
                {['added', 'moved', 'retitled', 'removed', 'same'].map((s) => (
                    <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 11, height: 11, borderRadius: 3, border: `1.5px solid ${STATUS[s].bd}`, background: STATUS[s].bg }} />{STATUS[s].label}
                    </span>
                ))}
                <span style={{ flex: 1 }} />
                <span>Structural render from stored source. No searches run.</span>
            </div>
        </div>
    );
}
