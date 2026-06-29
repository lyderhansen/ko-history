/*
 * lineDiff — shared LCS line-diff engine used by all four custom vizs and the
 * React wrapper.
 *
 * Algorithm: prefix/suffix trim first (fast path), then LCS on the differing
 * middle only using Int32Array (typed array avoids GC pressure on large diffs).
 * Degrades gracefully to a block-replace when the LCS table would exceed the
 * cell cap (default 6 000 000) so a pathological pair can't hang the browser.
 *
 * ES5 + CommonJS (module.exports) so both the viz AMD bundles and the React
 * ESM wrapper can require/import it via relative path.
 *
 * API
 * ---
 *   lineDiffCore(aLines, bLines[, cap])
 *     aLines / bLines : string[]  — the two sequences to diff
 *     cap             : number    — max Int32Array cells (default 6 000 000)
 *     returns: { ops: [{t:'eq'|'del'|'add', a:string, b:string|null}], degraded: bool }
 *       - t:'eq'  → a===b (common line); a and b both hold the line text
 *       - t:'del' → line present in a only;  b is null
 *       - t:'add' → line present in b only;  a is null
 *       - degraded=true when the block-replace fallback was used
 *
 * Each consumer wraps lineDiffCore with a thin adapter that maps the generic
 * ops to its own rendering format (see call sites).
 */

(function (factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        (typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {}).lineDiffCore = factory();
    }
}(function () {

    var DEFAULT_CAP = 6000000;

    function lineDiffCore(aLines, bLines, cap) {
        var a = aLines || [];
        var b = bLines || [];
        var n = a.length;
        var m = b.length;
        if (cap === undefined || cap === null) cap = DEFAULT_CAP;

        // Trim common prefix.
        var start = 0;
        while (start < n && start < m && a[start] === b[start]) start++;

        // Trim common suffix (from the UNtrimmed ends).
        var endA = n, endB = m;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

        var ops = [];
        var i, j;

        // Emit common prefix as eq ops.
        for (i = 0; i < start; i++) ops.push({ t: 'eq', a: a[i], b: b[i] });

        var mn = endA - start, mm = endB - start;

        if (mn === 0 && mm === 0) {
            // Nothing in the middle to diff — fall through to suffix.
        } else if (mn === 0) {
            // Only additions in the middle.
            for (j = start; j < endB; j++) ops.push({ t: 'add', a: null, b: b[j] });
        } else if (mm === 0) {
            // Only deletions in the middle.
            for (i = start; i < endA; i++) ops.push({ t: 'del', a: a[i], b: null });
        } else if ((mn + 1) * (mm + 1) > cap) {
            // LCS table would be too large — degrade to block replace.
            for (i = start; i < endA; i++) ops.push({ t: 'del', a: a[i], b: null });
            for (j = start; j < endB; j++) ops.push({ t: 'add', a: null, b: b[j] });
            // Emit suffix eq and return early with the degraded flag.
            for (i = endA; i < n; i++) ops.push({ t: 'eq', a: a[i], b: b[i - endA + endB] });
            return { ops: ops, degraded: true };
        } else {
            // LCS on the middle slice.
            var W = mm + 1;
            var C = new Int32Array((mn + 1) * W);
            for (i = mn - 1; i >= 0; i--) {
                for (j = mm - 1; j >= 0; j--) {
                    if (a[start + i] === b[start + j]) {
                        C[i * W + j] = C[(i + 1) * W + (j + 1)] + 1;
                    } else {
                        var down = C[(i + 1) * W + j];
                        var right = C[i * W + (j + 1)];
                        C[i * W + j] = down >= right ? down : right;
                    }
                }
            }
            i = 0; j = 0;
            while (i < mn && j < mm) {
                if (a[start + i] === b[start + j]) {
                    ops.push({ t: 'eq', a: a[start + i], b: b[start + j] }); i++; j++;
                } else if (C[(i + 1) * W + j] >= C[i * W + (j + 1)]) {
                    ops.push({ t: 'del', a: a[start + i], b: null }); i++;
                } else {
                    ops.push({ t: 'add', a: null, b: b[start + j] }); j++;
                }
            }
            while (i < mn) { ops.push({ t: 'del', a: a[start + i], b: null }); i++; }
            while (j < mm) { ops.push({ t: 'add', a: null, b: b[start + j] }); j++; }
        }

        // Emit common suffix as eq ops.
        for (i = endA; i < n; i++) ops.push({ t: 'eq', a: a[i], b: b[i - endA + endB] });
        return { ops: ops, degraded: false };
    }

    return lineDiffCore;
}));
