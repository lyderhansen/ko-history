/*
 * highlightInject — draw change-highlight boxes INTO a rendered dashboard iframe,
 * NOTE: The core algorithm (selectors, CSS.escape guard, outerHTML fallback,
 * dashed-removed, maxTries) is kept in sync with dashboard_preview viz's
 * _findPanels/_matchPanel/_decorate/_scheduleHighlightInjection methods.
 * If you improve one, improve the other.
 * positioned over the real panels. Ported from the bundled dashboard_preview viz's
 * in-iframe highlight injection (selector ladder → match panel by viz id / index →
 * append an absolutely-positioned box + badge). Used by the wrapper's Visual compare
 * tab so the rectangles overlay the actual rendered dashboard, not a schematic.
 *
 * The iframe must be SAME-ORIGIN (it is — the preview slots live in this app).
 *
 * changes: [{ id, idx, kind, label }]
 *   id   — DS visualization id (matched against panel element attributes)
 *   idx  — panel index in document order (Simple XML fallback)
 *   kind — 'added' | 'moved' | 'retitled' | 'removed' | 'changed'
 *   label— short text for the badge
 */

// `glow` is a ready-to-use CSS color (or color-with-alpha) for the inset
// box-shadow — carried explicitly rather than synthesized by string-concatenating
// an alpha suffix onto `border`, because that only works for hex colors (the
// defaults below); OKLCH/rgb overrides need their own alpha-bearing value.
const KIND = {
    added: { border: '#46aa5a', glow: '#46aa5a22', label: 'ADDED' },
    moved: { border: '#d6b35a', glow: '#d6b35a22', label: 'MOVED' },
    retitled: { border: '#5ca5d6', glow: '#5ca5d622', label: 'RETITLED' },
    removed: { border: '#e0505a', glow: '#e0505a22', label: 'REMOVED' },
    changed: { border: '#d6b35a', glow: '#d6b35a22', label: 'CHANGED' },
};

// Merge an optional kind→color override map over the defaults, keeping each
// kind's label untouched. Returns KIND itself when no overrides are given, so
// callers that omit `colors` behave identically to before this was added.
// Each override may be a plain color string (legacy shape: hex only, so the
// glow can be synthesized by appending an alpha suffix) or a { border, glow }
// pair (current shape: glow is carried as-is).
//
// Appending an alpha suffix is ONLY valid for hex. Doing it to an OKLCH string
// produces an invalid color, and a single invalid color voids the entire CSS
// declaration it appears in, silently dropping the highlight box. So a pair
// without an explicit `glow` falls back to the default glow rather than
// synthesizing one from a border whose format is unknown.
function buildColorMap(overrides) {
    if (!overrides) return KIND;
    const map = {};
    Object.keys(KIND).forEach((k) => {
        const o = overrides[k];
        if (!o) { map[k] = KIND[k]; return; }
        if (typeof o === 'string') {
            map[k] = { border: o, glow: o + '22', label: KIND[k].label };
        } else {
            map[k] = {
                border: o.border || KIND[k].border,
                glow: o.glow || KIND[k].glow,
                label: KIND[k].label,
            };
        }
    });
    return map;
}

function ensureStyle(doc) {
    if (doc.getElementById('koov-hl-style')) return;
    const css =
        '.koov-hl{position:absolute;pointer-events:none;box-sizing:border-box;border-radius:3px;}' +
        '.koov-hl--box{inset:0;border-width:2px;border-style:solid;z-index:9998;}' +
        '.koov-hl--abs{border-width:2px;border-style:solid;z-index:9998;}' +
        '.koov-hl--badge{z-index:9999;font:700 9px/1.4 ui-sans-serif,system-ui,sans-serif;' +
        'letter-spacing:.05em;padding:2px 6px;border-radius:3px;color:#0b0c10;white-space:nowrap;}';
    const st = doc.createElement('style');
    st.id = 'koov-hl-style';
    st.textContent = css;
    (doc.head || doc.body).appendChild(st);
}

// Find the rendered canvas element by its declared pixel size (DS absolute
// layout renders the canvas at canvasW×canvasH, then CSS-scales it — offsetWidth
// reports the unscaled size, so this matches regardless of zoom).
function findCanvasRoot(doc, cw, ch) {
    if (!cw || !ch) return null;
    const all = doc.body.getElementsByTagName('*');
    let best = null;
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const ow = el.offsetWidth, oh = el.offsetHeight;
        if (Math.abs(ow - cw) <= 2 && Math.abs(oh - ch) <= 2) { best = el; break; }
    }
    return best;
}

// Draw a box + badge at canvas coordinates inside the (transform-scaled) canvas
// root — the box scales with the dashboard automatically.
function decorateCoord(doc, root, ch, colorMap) {
    const col = (colorMap || KIND)[ch.kind] || (colorMap || KIND).changed;
    const box = doc.createElement('div');
    box.className = 'koov-hl koov-hl--abs';
    box.style.left = ch.x + 'px';
    box.style.top = ch.y + 'px';
    box.style.width = ch.w + 'px';
    box.style.height = ch.h + 'px';
    box.style.borderColor = col.border;
    box.style.borderStyle = ch.kind === 'removed' ? 'dashed' : 'solid';
    box.style.boxShadow = 'inset 0 0 24px ' + col.glow;
    root.appendChild(box);
    const badge = doc.createElement('div');
    badge.className = 'koov-hl koov-hl--badge';
    badge.style.left = (ch.x + 3) + 'px';
    badge.style.top = (ch.y + 3) + 'px';
    badge.style.background = col.border;
    badge.textContent = col.label + (ch.label ? ' · ' + String(ch.label).slice(0, 28) : '');
    root.appendChild(badge);
}

function findPanels(doc, override) {
    let selectors = [];
    if (override) selectors.push(override);
    selectors = selectors.concat([
        '[data-input-id][data-viz-type]',
        '[data-test="visualization"]',
        '[data-testid="visualization"]',
        '[data-input-id]',
        '[data-test-input-id]',
        '[data-viz-id]',
        '[data-element-id]',
        '[data-component="DashboardElement"]',
        '.dashboard-element',
        '.dashboard-panel',
    ]);
    for (let i = 0; i < selectors.length; i++) {
        let found;
        try { found = doc.querySelectorAll(selectors[i]); } catch (e) { found = null; }
        if (found && found.length) {
            const arr = [];
            for (let j = 0; j < found.length; j++) arr.push(found[j]);
            return { panels: arr, selector: selectors[i] };
        }
    }
    return { panels: [], selector: '' };
}

function matchPanel(panels, ch, doc) {
    const id = ch.id != null ? String(ch.id) : '';
    if (id) {
        // exact id / any attribute value equals the viz id
        for (let i = 0; i < panels.length; i++) {
            const n = panels[i];
            if (n.id === id) return n;
            if (n.attributes) {
                for (let k = 0; k < n.attributes.length; k++) {
                    if (n.attributes[k].value === id) return n;
                }
            }
        }
        // an element carrying the id anywhere in the doc → walk up to a found panel
        let esc = id;
        try { if (typeof window !== 'undefined' && window.CSS && window.CSS.escape) esc = window.CSS.escape(id); } catch (e) { /* */ }
        let host = null;
        try { host = doc.querySelector('[id="' + esc + '"], [data-input-id="' + esc + '"], [data-test-input-id="' + esc + '"], [data-viz-id="' + esc + '"]'); } catch (e) { host = null; }
        if (host) {
            for (let i = 0; i < panels.length; i++) {
                if (panels[i] === host || panels[i].contains(host) || host.contains(panels[i])) return panels[i];
            }
            return host;
        }
        // substring fallback on a generous slice of markup
        for (let i = 0; i < panels.length; i++) {
            const html = panels[i].outerHTML ? panels[i].outerHTML.slice(0, 1200) : '';
            if (html.indexOf(id) !== -1) return panels[i];
        }
    }
    if (typeof ch.idx === 'number') return panels[ch.idx] || null;
    return null;
}

function decorate(doc, node, ch, colorMap) {
    const cs = (doc.defaultView || window).getComputedStyle(node);
    if (cs && cs.position === 'static') node.style.position = 'relative';
    const col = (colorMap || KIND)[ch.kind] || (colorMap || KIND).changed;
    const box = doc.createElement('div');
    box.className = 'koov-hl koov-hl--box';
    box.style.borderColor = col.border;
    box.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.25), inset 0 0 18px ' + col.glow;
    node.appendChild(box);
    const badge = doc.createElement('div');
    badge.className = 'koov-hl koov-hl--badge';
    badge.style.background = col.border;
    badge.textContent = col.label + (ch.label ? ' · ' + String(ch.label).slice(0, 28) : '');
    node.appendChild(badge);
}

function clearHlDoc(doc) {
    const prev = doc.querySelectorAll('.koov-hl');
    for (let r = 0; r < prev.length; r++) prev[r].parentNode && prev[r].parentNode.removeChild(prev[r]);
}

// Remove any injected .koov-hl boxes from the iframe's document.
// Safe to call even before the iframe has loaded (no-ops silently).
export function clearHighlights(iframe) {
    try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (doc) clearHlDoc(doc);
    } catch (e) { /* cross-origin or not-yet-loaded — ignore */ }
}

// Poll the iframe until its panels render, inject boxes, and keep them until
// stopped. Returns a stop() that clears the boxes. DS renders async, so we retry.
export function startHighlightPoll(iframe, changes, opts, onReport, colors) {
    opts = opts || {};
    let timer = null, tries = 0, last = -1, stable = 0;
    const maxTries = 25;
    const colorMap = buildColorMap(colors);
    const report = (r) => { if (typeof onReport === 'function') { try { onReport(r); } catch (e) { /* */ } } };

    function tryInject() {
        let doc;
        try { doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document); }
        catch (e) { return { done: true, count: 0, found: 0, selector: 'cross-origin' }; }
        if (!doc || !doc.body) return { done: false, count: 0, found: 0, selector: '' };
        ensureStyle(doc);
        clearHlDoc(doc);

        // Primary: coordinate mode — find the canvas by its declared size and drop
        // boxes at panel coords (works for DS absolute layouts; no element matching).
        if (opts.canvasW && opts.canvasH) {
            const root = findCanvasRoot(doc, opts.canvasW, opts.canvasH);
            if (root) {
                const cs = (doc.defaultView || window).getComputedStyle(root);
                if (cs && cs.position === 'static') root.style.position = 'relative';
                let injected = 0;
                for (let i = 0; i < changes.length; i++) {
                    if (typeof changes[i].x === 'number') { decorateCoord(doc, root, changes[i], colorMap); injected++; }
                }
                return { done: true, count: injected, found: 1, selector: 'canvas ' + opts.canvasW + '×' + opts.canvasH };
            }
            // canvas not rendered yet → keep polling (don't fall back to bad selectors)
            return { done: false, count: 0, found: 0, selector: 'awaiting canvas' };
        }

        // Fallback: element matching (classic Simple XML / unknown canvas).
        const fp = findPanels(doc, opts.selector);
        if (!fp.panels.length) return { done: false, count: 0, found: 0, selector: '' };
        let injected = 0;
        for (let i = 0; i < changes.length; i++) {
            const node = matchPanel(fp.panels, changes[i], doc);
            if (node) { decorate(doc, node, changes[i], colorMap); injected++; }
        }
        return { done: true, count: injected, found: fp.panels.length, selector: fp.selector };
    }

    const first = tryInject();
    report(first);
    timer = setInterval(() => {
        tries++;
        const r = tryInject();
        report(r);
        if (r.done) {
            if (r.count === last) stable++; else stable = 0;
            last = r.count;
            if (stable >= 2 || tries >= maxTries) { clearInterval(timer); timer = null; }
        } else if (tries >= maxTries) { clearInterval(timer); timer = null; }
    }, 450);

    return function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        try {
            const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (doc) clearHlDoc(doc);
        } catch (e) { /* ignore */ }
    };
}
