/*
 * SPL tokenizer, shared by the ko_viewer visualization and the React wrapper.
 *
 * Returns tokens rather than HTML so each host can render them its own way:
 * ko_viewer builds spans with CSS classes (it lives in a sandboxed iframe with
 * its own stylesheet), while the wrapper builds inline-styled React nodes from
 * palette tokens. One tokenizer means the two can never disagree about what a
 * command or a string literal is.
 *
 * Deliberately approximate. This is a readability aid for an admin scanning a
 * saved search, not a parser: SPL's real grammar is context-sensitive, and a
 * wrong colour here costs nothing.
 *
 * CommonJS to match the other node-tested shared modules (sourceLines,
 * lineDiff); webpack imports it from ESM without ceremony.
 */

// Order matters: the alternation is tried left to right, so quoted strings win
// over everything inside them, and `| command` wins over a bare word.
//   1 string    "..."            (SPL has no single-quoted string; '...' is a field name)
//   2 command   | rex, | eval    (the pipe and the command name together)
//   3 function  name immediately followed by (
//   4 keyword   AS BY OR AND NOT IN OUTPUT/OUTPUTNEW
//   5 number    integer or decimal, optionally negative
var TOKEN_RE = /("[^"]*")|(\|\s*[A-Za-z_]+)|([A-Za-z_]\w*)(?=\s*\()|\b(AS|BY|OR|AND|NOT|IN|OUTPUT(?:NEW)?)\b|(-?\b\d+(?:\.\d+)?\b)/gi;

var KINDS = ['str', 'cmd', 'fn', 'kw', 'num'];

/*
 * tokenizeSpl('| eval x=if(a="b",1,2)') ->
 *   [{kind:'cmd', text:'| eval'}, {kind:'text', text:' x='}, {kind:'fn', text:'if'}, ...]
 *
 * Concatenating every token's `text` always reproduces the input exactly, which
 * is what lets a caller render tokens without worrying about dropped characters.
 */
function tokenizeSpl(line) {
    var src = line == null ? '' : String(line);
    var out = [];
    var last = 0;
    var m;
    // Fresh lastIndex per call: TOKEN_RE is module-level and /g is stateful.
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src)) !== null) {
        if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) });
        for (var i = 0; i < KINDS.length; i++) {
            if (m[i + 1] !== undefined) { out.push({ kind: KINDS[i], text: m[i + 1] }); break; }
        }
        last = m.index + m[0].length;
        // A zero-length match would spin forever; SPL patterns above cannot
        // produce one, but the guard is cheap next to a hung browser tab.
        if (m[0] === '') TOKEN_RE.lastIndex++;
    }
    if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
    return out;
}

module.exports = { tokenizeSpl: tokenizeSpl, KINDS: KINDS };
