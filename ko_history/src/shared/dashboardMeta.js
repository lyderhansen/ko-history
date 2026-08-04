/*
 * dashboardMeta — what a captured dashboard IS, at a glance.
 *
 * Answers the questions the raw source cannot without reading it: is this
 * Simple XML or Dashboard Studio, what is it called, how many panels and
 * searches does it carry. Used by the ko_viewer record card so a dashboard gets
 * the same treatment a saved search already gets.
 *
 * Detection deliberately mirrors src/util/schematic.js (isStudio / dsJsonText).
 * That module does panel GEOMETRY for the wrapper's overlay and is an ES module
 * the viz AMD bundles cannot load; this one does identity and counts. If the
 * detection rules ever change, change both, or the wrapper and the card will
 * disagree about what a dashboard is.
 *
 * ES5 + CommonJS so both the viz AMD bundles and Node can load it.
 */
(function (factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        (typeof globalThis !== 'undefined' ? globalThis
            : typeof window !== 'undefined' ? window : {}).dashboardMeta = factory();
    }
}(function () {

    // The JSON body of a Studio dashboard, whether bare or wrapped in the
    // <dashboard version="2"><definition><![CDATA[ ... ]]></definition> envelope
    // that data/ui/views actually stores. Returns null when there is none.
    function dsJsonText(raw) {
        var s = String(raw == null ? '' : raw);
        var defm = s.match(/<definition[^>]*>([\s\S]*?)<\/definition>/i);
        if (defm) {
            var inner = defm[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/^\s+/, '');
            if (inner.charAt(0) === '{' || inner.charAt(0) === '[') return inner;
        }
        var t = s.replace(/^[\uFEFF\s]+/, '');
        if (t.charAt(0) === '{' || t.charAt(0) === '[') return t;
        return null;
    }

    function isStudio(raw) {
        var s = String(raw == null ? '' : raw);
        return /<definition\b/i.test(s) ||
            /<dashboard[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
            /<form[^>]*\bversion\s*=\s*["']2["']/i.test(s) ||
            (/^[\uFEFF\s]*[{[]/.test(s) && /"layout"\s*:/.test(s));
    }

    function attr(tag, name) {
        var m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
        return m ? m[1] : '';
    }

    function tagText(s, name) {
        var m = s.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
        if (!m) return '';
        return m[1]
            .replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
            .replace(/<[^>]*>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/^\s+|\s+$/g, '');
    }

    function countTags(s, name) {
        // Counts opening tags only, so <panel>...</panel> is one, and a
        // self-closing <search .../> still counts.
        var re = new RegExp('<' + name + '(\\s[^>]*)?/?>', 'gi');
        var n = 0;
        while (re.exec(s) !== null) n++;
        return n;
    }

    function size(o) {
        if (!o || typeof o !== 'object') return 0;
        return Object.keys(o).length;
    }

    /*
     * meta(raw) -> {
     *   format:      'Dashboard Studio' | 'Simple XML' | 'Unknown'
     *   isStudio:    bool
     *   label:       the dashboard's own title, '' if absent
     *   description: '' if absent
     *   version:     the root element's version attribute, '' for bare JSON
     *   theme:       'light' | 'dark' | ''
     *   panels:      count, or null when it could not be determined
     *   searches:    count, or null
     *   inputs:      count, or null
     *   parseError:  true when it looks like Studio but the JSON would not parse
     * }
     *
     * Counts are null rather than 0 when unknown: "we could not tell" and
     * "genuinely has none" are different facts, and a card that prints 0 panels
     * for an unparseable dashboard is stating something false.
     */
    function meta(raw) {
        var s = String(raw == null ? '' : raw);
        var out = {
            format: 'Unknown', isStudio: false, label: '', description: '',
            version: '', theme: '', panels: null, searches: null, inputs: null,
            parseError: false
        };
        if (!s.replace(/\s+/g, '')) return out;

        var rootTag = (s.match(/<(dashboard|form)\b[^>]*>/i) || [''])[0];
        out.version = rootTag ? attr(rootTag, 'version') : '';
        out.theme = rootTag ? attr(rootTag, 'theme') : '';

        if (isStudio(s)) {
            out.isStudio = true;
            out.format = 'Dashboard Studio';
            var jt = dsJsonText(s);
            if (!jt) { out.parseError = true; return out; }
            var d;
            try {
                d = JSON.parse(jt);
            } catch (e) {
                out.parseError = true;
                return out;
            }
            if (!d || typeof d !== 'object') { out.parseError = true; return out; }
            out.label = typeof d.title === 'string' ? d.title : '';
            out.description = typeof d.description === 'string' ? d.description : '';
            if (!out.version) out.version = '2';
            if (typeof d.theme === 'string' && !out.theme) out.theme = d.theme;
            out.panels = size(d.visualizations);
            out.searches = size(d.dataSources);
            out.inputs = size(d.inputs);
            return out;
        }

        if (rootTag) {
            out.format = 'Simple XML';
            out.label = tagText(s, 'label');
            out.description = tagText(s, 'description');
            if (!out.version) out.version = '1.1';
            out.panels = countTags(s, 'panel');
            out.searches = countTags(s, 'search');
            out.inputs = countTags(s, 'input');
        }
        return out;
    }

    meta.isStudio = isStudio;
    meta.dsJsonText = dsJsonText;
    return meta;
}));
