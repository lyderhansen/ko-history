/*
 * pairDiff — turn a flat op list into side-by-side rows, numbered.
 *
 * Extracted from source_viewer so Node can test it: the numbering is the sort
 * of thing that looks right on screen and is quietly off by one.
 *
 * Input  : [{t:'eq'|'del'|'add', line:<opaque>}]  (see shared/lineDiff.js)
 * Output : [{l, r, lt, rt, ln, rn}]
 *   l / r   the older and newer line objects, or null where that side has none
 *   lt / rt 'eq' | 'del' | 'add' | 'none'  ('none' = padding cell)
 *   ln / rn 1-based line number in the OLDER and NEWER source, or null
 *
 * The two counters advance independently. They count SOURCE lines, not rows, so
 * they drift apart exactly where one side gained or lost lines, which is what
 * makes them worth showing at all. A padding cell gets null rather than
 * borrowing its neighbour's number, because a number against a blank line is
 * worse than no number.
 *
 * ES5 + CommonJS so both the viz AMD bundle and Node can load it.
 */
(function (factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        (typeof globalThis !== 'undefined' ? globalThis
            : typeof window !== 'undefined' ? window : {}).pairDiff = factory();
    }
}(function () {
    return function pairDiff(ops) {
        var rows = [], i = 0, ln = 0, rn = 0;
        var list = ops || [];
        while (i < list.length) {
            if (list[i].t === 'eq') {
                ln++; rn++;
                rows.push({ l: list[i].line, r: list[i].line, lt: 'eq', rt: 'eq', ln: ln, rn: rn });
                i++;
                continue;
            }
            // A run of deletions followed by a run of additions is one change,
            // shown as aligned pairs. Whichever run is shorter pads with nulls.
            var dels = [], adds = [];
            while (i < list.length && list[i].t === 'del') { dels.push(list[i].line); i++; }
            while (i < list.length && list[i].t === 'add') { adds.push(list[i].line); i++; }
            // Guard against an op type we do not know: without this the outer
            // while would spin forever on it.
            if (!dels.length && !adds.length) { i++; continue; }
            var nn = Math.max(dels.length, adds.length);
            for (var k = 0; k < nn; k++) {
                var hasL = k < dels.length, hasR = k < adds.length;
                if (hasL) ln++;
                if (hasR) rn++;
                rows.push({
                    l: hasL ? dels[k] : null,
                    r: hasR ? adds[k] : null,
                    lt: hasL ? 'del' : 'none',
                    rt: hasR ? 'add' : 'none',
                    ln: hasL ? ln : null,
                    rn: hasR ? rn : null
                });
            }
        }
        return rows;
    };
}));
