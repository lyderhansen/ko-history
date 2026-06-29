/*
 * schematic — parse a stored KO dashboard (DS JSON or Simple XML) into a set of
 * positioned panel boxes, so the version timeline can draw a structural
 * schematic and animate how it changes across versions. Pure client-side, no
 * search run — this is a *layout* view, not a data render.
 *
 * parseSchematic(raw) -> { format, canvasW, canvasH, panels: [{id,title,type,x,y,w,h}] }
 *
 * DS: read layout.structure positions + visualizations titles/types. If a layout
 *     has no absolute coordinates (e.g. grid), fall back to a flow grid by order.
 * SXML: synthesize a grid from <row>/<panel> (classic XML has no absolute coords).
 */

const MAX_PANELS = 80;
const FLOW_COLS = 3;
const FLOW_W = 400;
const FLOW_H = 240;
const FLOW_GAP = 24;

function dsJsonText(raw) {
    const s = String(raw == null ? '' : raw);
    const defm = s.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
    if (defm) {
        const inner = defm[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/^\s+/, '');
        if (inner.charAt(0) === '{' || inner.charAt(0) === '[') return inner;
    }
    const t = s.replace(/^[﻿\s]+/, '');
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return t;
    return null;
}

function isStudio(raw) {
    const s = String(raw == null ? '' : raw);
    return /<definition\b/i.test(s) ||
        /<dashboard[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
        /<form[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
        (/^[\s﻿]*[{[]/.test(s) && /"layout"\s*:/.test(s));
}

function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
}

function flow(panels) {
    // Assign flow-grid coordinates by order (used when no absolute coords exist).
    for (let i = 0; i < panels.length; i++) {
        const col = i % FLOW_COLS;
        const row = Math.floor(i / FLOW_COLS);
        panels[i].x = FLOW_GAP + col * (FLOW_W + FLOW_GAP);
        panels[i].y = FLOW_GAP + row * (FLOW_H + FLOW_GAP);
        panels[i].w = FLOW_W;
        panels[i].h = FLOW_H;
    }
    const cols = Math.min(FLOW_COLS, panels.length || 1);
    const rows = Math.ceil((panels.length || 1) / FLOW_COLS);
    return {
        canvasW: FLOW_GAP + cols * (FLOW_W + FLOW_GAP),
        canvasH: FLOW_GAP + rows * (FLOW_H + FLOW_GAP),
    };
}

function parseStudio(jsonText) {
    let def;
    try { def = JSON.parse(jsonText); } catch (e) { return null; }
    const viz = def.visualizations || {};
    const layout = def.layout || {};
    const inputs = def.inputs || {};

    // Positions live in layout.structure (single absolute page) OR, for grid /
    // background-image / tabbed dashboards, in layout.layoutDefinitions.<id>.structure.
    // Use the first tab's definition (or the first definition) in that case.
    let structure = Array.isArray(layout.structure) ? layout.structure : [];
    let lopts = layout.options || {};
    if (!structure.length && layout.layoutDefinitions && typeof layout.layoutDefinitions === 'object') {
        const defs = layout.layoutDefinitions;
        let defId = null;
        if (Array.isArray(layout.tabs) && layout.tabs.length) defId = layout.tabs[0].layoutId || null;
        if (!defId || !defs[defId]) defId = Object.keys(defs)[0];
        const ld = (defId && defs[defId]) || {};
        structure = Array.isArray(ld.structure) ? ld.structure : [];
        lopts = ld.options || lopts;
    }

    const panels = [];
    let haveCoords = false;
    structure.forEach((entry) => {
        if (!entry || !entry.item) return;
        const id = entry.item;
        const v = viz[id] || inputs[id] || {};
        const pos = entry.position || {};
        const x = num(pos.x), y = num(pos.y), w = num(pos.w), h = num(pos.h);
        const hasCoords = x != null && y != null && w != null && h != null;
        if (hasCoords) haveCoords = true;
        const isInput = !!inputs[id] && !viz[id];
        panels.push({
            id,
            title: String(v.title || id),
            type: String((v.type || (isInput ? 'input' : '')) || '').replace(/^splunk\./, '').replace(/^input\./, 'input:'),
            x: x, y: y, w: w, h: h,
            _input: isInput,
        });
        if (panels.length >= MAX_PANELS) return;
    });

    let canvasW, canvasH;
    if (haveCoords) {
        // Some entries may lack coords in an otherwise-absolute layout → flow them after.
        let maxX = 0, maxY = 0;
        panels.forEach((p) => {
            if (p.x == null) return;
            if (p.x + p.w > maxX) maxX = p.x + p.w;
            if (p.y + p.h > maxY) maxY = p.y + p.h;
        });
        canvasW = num(lopts.width) || maxX || 1440;
        canvasH = num(lopts.height) || maxY || 800;
        // place any coord-less panels in a trailing flow row
        let fy = canvasH + FLOW_GAP, fx = FLOW_GAP, placed = false;
        panels.forEach((p) => {
            if (p.x == null) {
                placed = true;
                p.x = fx; p.y = fy; p.w = FLOW_W; p.h = FLOW_H;
                fx += FLOW_W + FLOW_GAP;
                if (fx + FLOW_W > canvasW) { fx = FLOW_GAP; fy += FLOW_H + FLOW_GAP; }
            }
        });
        if (placed) canvasH = fy + FLOW_H + FLOW_GAP;
    } else {
        const c = flow(panels);
        canvasW = c.canvasW; canvasH = c.canvasH;
    }
    return { format: 'Dashboard Studio', canvasW: canvasW, canvasH: canvasH, panels: panels };
}

function parseSxml(xml) {
    const s = String(xml);
    const panels = [];
    // Walk rows; within each row, collect panels. Title = <panel><title> or the
    // first viz element name. Classic XML has no coords → synthesize a grid where
    // each row is a schematic row and panels split the width evenly.
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    let rm;
    const rows = [];
    while ((rm = rowRe.exec(s)) !== null) rows.push(rm[1]);
    const blocks = rows.length ? rows : [s]; // formless dashboards → one pseudo-row

    const VIZ = /<(chart|table|single|map|event|viz|html|list|input)\b[^>]*>/i;
    // Classic XML has no stable panel id. Derive one from the title (else type),
    // deduped by occurrence, so a panel keeps identity across versions even when
    // rows are reordered — makes add/remove tracking clean. (Positions are still
    // synthesized from row/column order, so "moved" stays approximate.)
    const seen = {};
    const ROW_H = 220, GAP = 20, CANVAS_W = 1280;
    let y = GAP;
    blocks.forEach((rowXml) => {
        const panelRe = /<panel\b[^>]*>([\s\S]*?)<\/panel>/gi;
        let pm;
        const cells = [];
        while ((pm = panelRe.exec(rowXml)) !== null) cells.push(pm[1]);
        const list = cells.length ? cells : (VIZ.test(rowXml) ? [rowXml] : []);
        const n = list.length;
        if (!n) return;
        const cw = Math.floor((CANVAS_W - GAP * (n + 1)) / n);
        list.forEach((cell, ci) => {
            const tm = cell.match(/<title>([\s\S]*?)<\/title>/i);
            const vm = cell.match(/<(chart|table|single|map|event|viz|html|list|input)\b/i);
            const title = tm ? tm[1].replace(/\s+/g, ' ').trim() : (vm ? vm[1] : 'panel');
            const type = vm ? vm[1].toLowerCase() : 'panel';
            const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || type) + ':' + type;
            const occ = (seen[base] = (seen[base] || 0) + 1);
            panels.push({
                id: base + (occ > 1 ? '#' + occ : ''),
                title: title,
                type: type,
                x: GAP + ci * (cw + GAP),
                y: y,
                w: cw,
                h: ROW_H,
                _input: type === 'input',
            });
            if (panels.length >= MAX_PANELS) return;
        });
        y += ROW_H + GAP;
    });
    return { format: 'Simple XML', canvasW: CANVAS_W, canvasH: Math.max(y + GAP, ROW_H + GAP * 2), panels: panels };
}

export function parseSchematic(raw) {
    const empty = { format: 'Raw', canvasW: 1280, canvasH: 400, panels: [] };
    if (!raw) return empty;
    if (isStudio(raw)) {
        const jt = dsJsonText(raw);
        if (jt) {
            const r = parseStudio(jt);
            if (r) return r;
        }
        // DS wrapper but JSON unreadable → try SXML-ish parse as a fallback
    }
    const sx = parseSxml(raw);
    if (sx.panels.length) return sx;
    return empty;
}

// Diff two schematics' panels by id: returns a status per CURRENT panel id, plus
// the ids removed since the previous frame.
// status: 'added' | 'moved' | 'retitled' | 'same'
export function diffSchematic(prev, cur) {
    const status = {};
    const removed = [];
    const prevById = {};
    (prev ? prev.panels : []).forEach((p) => { prevById[p.id] = p; });
    const curById = {};
    cur.panels.forEach((p) => { curById[p.id] = p; });

    cur.panels.forEach((p) => {
        const was = prevById[p.id];
        if (!was) { status[p.id] = 'added'; return; }
        const moved = was.x !== p.x || was.y !== p.y || was.w !== p.w || was.h !== p.h;
        const retitled = was.title !== p.title;
        status[p.id] = moved ? 'moved' : (retitled ? 'retitled' : 'same');
    });
    if (prev) prev.panels.forEach((p) => { if (!curById[p.id]) removed.push(p); });

    let added = 0, moved = 0, retitled = 0;
    Object.keys(status).forEach((k) => {
        if (status[k] === 'added') added++;
        else if (status[k] === 'moved') moved++;
        else if (status[k] === 'retitled') retitled++;
    });
    return { status: status, removed: removed, counts: { added: added, moved: moved, retitled: retitled, removed: removed.length } };
}
