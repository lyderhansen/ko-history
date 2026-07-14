import React from 'react';
import { buildView } from '../util/jsonView';

/*
 * SourceView — React renderer for the jsonView line model. Mirrors what the
 * bundled ko_history.source_viewer custom viz draws (foldable, syntax-highlighted,
 * line-numbered KO source) but client-side in the wrapper, no Splunk viz
 * round-trip. Dark-only (the wrapper is dark). See [[json-viewer-viz]].
 */

const STYLE_ID = 'kojv-wrapper-style';
const CSS = `
.kojv{position:relative;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;border-radius:3px;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,"SF Mono","Roboto Mono","DejaVu Sans Mono",Menlo,Consolas,monospace;}
.kojv--dark{--bg:#0B0C0E;--panel:#0B0C0E;--band:#131519;--edge:rgba(255,255,255,0.10);--gutter-bg:#0B0C0E;--gutter-rule:rgba(255,255,255,0.08);--header-bg:#16181D;--text:#C3CBD4;--text-dim:#9AA4AE;--text-faint:#5A636E;--primary:#4FA7D6;--accent:#4FA7D6;--t-key:#B8C4CF;--t-str:#C99A6A;--t-num:#94C273;--t-bool:#B392C4;--t-punct:#5CA5D6;--tag-bg:rgba(79,167,214,0.14);--tag-bd:rgba(79,167,214,0.45);--copied:#53A051;--row-hover:rgba(255,255,255,0.05);--accent-soft:rgba(79,167,214,0.14);--accent-bd:rgba(79,167,214,0.55);--copied-soft:rgba(83,160,81,0.14);--copied-bd:rgba(83,160,81,0.60);}
.kojv{background:var(--panel);border:1px solid var(--edge);}
.kojv__head{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:38px;padding:0 8px 0 12px;background:var(--header-bg);border-bottom:1px solid var(--edge);}
.kojv__tag{display:inline-flex;align-items:center;gap:7px;height:22px;padding:0 9px;background:var(--tag-bg);border:1px solid var(--tag-bd);border-radius:2px;font-weight:600;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--primary);white-space:nowrap;flex:0 0 auto;}
.kojv__tag::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--primary);opacity:.8;}
.kojv__tag--muted{color:var(--text-dim);border-color:var(--edge);background:transparent;}
.kojv__path{font-weight:500;font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1 1 auto;}
.kojv__path .sep{color:var(--text-faint);margin:0 2px;}
.kojv__meta{flex:0 0 auto;font-size:10.5px;letter-spacing:.04em;color:var(--text-dim);font-variant-numeric:tabular-nums;white-space:nowrap;}
.kojv__meta b{color:var(--text);font-weight:500;}
.kojv__foldall{display:inline-flex;align-items:center;gap:3px;flex:0 0 auto;}
.kojv__foldall button{cursor:pointer;background:transparent;color:var(--text-dim);border:1px solid var(--edge);border-radius:2px;min-width:22px;padding:3px 7px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;line-height:1;}
.kojv__foldall button:hover{color:var(--primary);border-color:var(--tag-bd);}
.kojv__foldlevel{font-size:10px;letter-spacing:.05em;color:var(--text-faint);min-width:58px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;}
.kojv__copy{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:24px;padding:0 10px;cursor:pointer;user-select:none;background:transparent;color:var(--accent);border:1px solid var(--accent-bd);border-radius:2px;font-weight:600;font-size:10px;letter-spacing:.09em;text-transform:uppercase;}
.kojv__copy:hover{background:var(--accent-soft);border-color:var(--accent);}
.kojv__copy.is-copied{color:var(--copied);border-color:var(--copied-bd);background:var(--copied-soft);}
.kojv__body{flex:1 1 auto;min-height:0;overflow:auto;font-size:12.5px;line-height:21px;font-variant-numeric:tabular-nums slashed-zero;background:var(--panel);}
.kojv__line{display:flex;min-height:21px;}
.kojv--banded .kojv__line--band{background:var(--band);}
.kojv--banded .kojv__line--band .kojv__ln{background:var(--band);}
.kojv__line:hover{background:var(--row-hover);}
.kojv__line:hover .kojv__ln{background:var(--row-hover);}
.kojv__ln{flex:0 0 50px;text-align:right;padding:0 10px 0 0;color:var(--text-faint);background:var(--gutter-bg);border-right:1px solid var(--gutter-rule);user-select:none;font-size:11px;}
.kojv__code{flex:1 1 auto;padding:0 14px 0 12px;white-space:pre;overflow:visible;color:var(--text);position:relative;}
.kojv__code--foldable{padding-left:18px;cursor:pointer;}
.kojv__fold{position:absolute;left:2px;top:0;width:12px;height:21px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;color:var(--text-faint);font-size:9px;line-height:1;}
.kojv__fold:hover{color:var(--primary);}
.kojv__fold::before{content:"\\25BC";}
.kojv__line.is-folded .kojv__fold::before{content:"\\25B6";}
.kojv__summary{display:none;margin-left:6px;padding:0 7px;border-radius:2px;background:var(--tag-bg);border:1px solid var(--tag-bd);color:var(--text-dim);font-size:11px;font-variant-numeric:tabular-nums;}
.kojv__line.is-folded .kojv__summary{display:inline-block;}
.kojv__k{color:var(--t-key);}
.kojv__s{color:var(--t-str);}
.kojv__n{color:var(--t-num);}
.kojv__b{color:var(--t-bool);font-style:italic;}
.kojv__p{color:var(--t-punct);}
.kojv__tg{color:var(--t-key);font-weight:500;}
.kojv__cd{color:var(--t-bool);font-style:italic;}
.kojv__cm{color:var(--text-faint);font-style:italic;}
.kojv__truncrow{cursor:pointer;background:transparent;border:none;padding:0;font:inherit;text-align:left;}
.kojv__truncrow .kojv__code{color:var(--text-faint);font-style:italic;}
.kojv__truncrow:hover .kojv__code{text-decoration:underline;color:var(--text-dim);}
`;

function injectStyle() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

function copyToClipboard(text, setCopied, timerRef) {
    const ok = () => {
        setCopied(true);
        if (timerRef && timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1400);
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok, legacy);
            return;
        }
    } catch (e) { /* fall through */ }
    legacy();
    function legacy() {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            ok();
        } catch (e2) { /* give up silently */ }
    }
}

// fold-id set that collapses every group at depth >= level (level<0 => none folded).
function foldedAtDepth(foldGroups, level) {
    const set = new Set();
    if (level >= 0) {
        for (const fid in foldGroups) {
            if (Object.prototype.hasOwnProperty.call(foldGroups, fid) && foldGroups[fid].depth >= level) set.add(fid);
        }
    }
    return set;
}

const LINE_CAP = 4000;

export default function SourceView({ raw, indent = 2, initialDepth = 0, title, app, banded = true }) {
    injectStyle();
    const view = React.useMemo(() => buildView(raw, indent), [raw, indent]);
    const { lines, foldGroups, maxDepth, label, pretty } = view;
    const muted = label === 'Raw' || label === 'Unparsed';

    const [folded, setFolded] = React.useState(() => foldedAtDepth(foldGroups, initialDepth));
    const [shownDepth, setShownDepth] = React.useState(initialDepth);
    const [copied, setCopied] = React.useState(false);
    const [showAll, setShowAll] = React.useState(false);
    const copyTimerRef = React.useRef(null);

    // Re-seed fold state and collapse show-all whenever the underlying source changes.
    React.useEffect(() => {
        setFolded(foldedAtDepth(foldGroups, initialDepth));
        setShownDepth(initialDepth);
        setShowAll(false);
    }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

    // Clear copy-flash timer on unmount to avoid setState after unmount.
    React.useEffect(() => {
        return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
    }, []);

    const hasFolds = Object.keys(foldGroups).length > 0;

    // Which line indices are hidden: any line inside (start,end] of a folded group.
    const hidden = React.useMemo(() => {
        const h = new Array(lines.length).fill(false);
        folded.forEach((fid) => {
            const g = foldGroups[fid];
            if (!g) return;
            for (let i = g.start + 1; i <= g.end; i++) h[i] = true;
        });
        return h;
    }, [folded, foldGroups, lines.length]);

    const toggle = (fid) => {
        setFolded((prev) => {
            const n = new Set(prev);
            if (n.has(fid)) n.delete(fid); else n.add(fid);
            return n;
        });
        setShownDepth(-2); // custom
    };
    const foldToDepth = (level) => {
        setFolded(foldedAtDepth(foldGroups, level));
        setShownDepth(level > maxDepth ? -1 : level);
    };
    const stepLevel = (dir) => {
        let cur = shownDepth;
        if (cur < 0) cur = maxDepth + 1; // treat "all" as one past deepest
        let next = cur + dir;
        if (next < 0) next = 0;
        if (next > maxDepth + 1) next = maxDepth + 1;
        foldToDepth(next > maxDepth ? -1 : next);
    };
    const levelText = shownDepth === -2 ? 'custom' : (shownDepth < 0 ? 'all levels' : `level ${shownDepth}/${maxDepth}`);

    const bytes = (pretty || '').length;

    // Collect visible (non-folded) line indices, then cap to LINE_CAP for initial render.
    const visibleIndices = React.useMemo(() => {
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            if (!hidden[i]) out.push(i);
        }
        return out;
    }, [lines, hidden]);
    const totalVisible = visibleIndices.length;
    const displayIndices = (showAll || totalVisible <= LINE_CAP) ? visibleIndices : visibleIndices.slice(0, LINE_CAP);

    // Render with a 2-row zebra cadence over the displayed set.
    let visIdx = 0;
    const rows = [];
    for (let di = 0; di < displayIndices.length; di++) {
        const i = displayIndices[di];
        const L = lines[i];
        const isFoldable = L.fold && foldGroups[L.fold];
        const isFolded = isFoldable && folded.has(L.fold);
        const band = banded && (Math.floor(visIdx / 2) % 2) === 1;
        visIdx++;
        rows.push(
            <div key={i} className={'kojv__line' + (isFolded ? ' is-folded' : '') + (band ? ' kojv__line--band' : '')}>
                <span className="kojv__ln">{i + 1}</span>
                {isFoldable ? (
                    <span className="kojv__code kojv__code--foldable" onClick={() => toggle(L.fold)}>
                        <span className="kojv__fold" />
                        <span dangerouslySetInnerHTML={{ __html: L.html }} />
                        <span className="kojv__summary">{L.summary || '…'}</span>
                    </span>
                ) : (
                    <span className="kojv__code" dangerouslySetInnerHTML={{ __html: L.html }} />
                )}
            </div>
        );
    }
    if (!showAll && totalVisible > LINE_CAP) {
        rows.push(
            <button key="show-all" type="button" className="kojv__truncrow kojv__line"
                    onClick={() => setShowAll(true)}>
                <span className="kojv__code">
                    {'truncated — showing first 4,000 of ' + totalVisible.toLocaleString() + ' lines · click to show all'}
                </span>
            </button>
        );
    }

    const segs = [];
    if (app) segs.push(<span key="a">{String(app)}</span>);
    segs.push(<span key="v">views</span>);
    if (title) segs.push(<b key="t" style={{ fontWeight: 600 }}>{String(title)}</b>);

    return (
        <div className="kojv kojv--dark kojv--banded">
            <div className="kojv__head">
                <span className={'kojv__tag' + (muted ? ' kojv__tag--muted' : '')}>{label}</span>
                {(app || title) ? (
                    <span className="kojv__path">
                        {segs.reduce((acc, s, idx) => {
                            if (idx > 0) acc.push(<span key={'s' + idx} className="sep">/</span>);
                            acc.push(s);
                            return acc;
                        }, [])}
                    </span>
                ) : <span className="kojv__path" />}
                <span className="kojv__meta"><b>{bytes.toLocaleString()}</b> bytes · <b>{lines.length}</b> lines</span>
                {hasFolds ? (
                    <span className="kojv__foldall">
                        <button type="button" title="Collapse all" onClick={() => foldToDepth(0)}>None</button>
                        <button type="button" title="Collapse one more level" onClick={() => stepLevel(-1)}>−</button>
                        <span className="kojv__foldlevel">{levelText}</span>
                        <button type="button" title="Expand one more level" onClick={() => stepLevel(1)}>+</button>
                        <button type="button" title="Expand all" onClick={() => foldToDepth(-1)}>All</button>
                    </span>
                ) : null}
                <button type="button" className={'kojv__copy' + (copied ? ' is-copied' : '')} onClick={() => copyToClipboard(pretty, setCopied, copyTimerRef)}>
                    {copied ? 'Copied ✓' : 'Copy'}
                </button>
            </div>
            <div className="kojv__body">{rows}</div>
        </div>
    );
}
