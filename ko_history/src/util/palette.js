/* Quiet Focus palette — dark values. The dynamic-theming item adds light values;
 * token NAMES are the contract. All panel colors come from here — no hex in JSX. */
const PAL = {
    bg:        'oklch(0.16 0.008 250)',
    panel:     'oklch(0.20 0.010 250)',
    panel2:    'oklch(0.23 0.010 250)',
    field:     'oklch(0.175 0.008 250)',
    edge:      'oklch(0.32 0.012 250)',
    edgeSoft:  'oklch(0.27 0.010 250)',
    text:      'oklch(0.90 0.006 250)',
    text2:     'oklch(0.72 0.010 250)',
    text3:     'oklch(0.56 0.012 250)',
    accent:    'oklch(0.62 0.155 250)',
    accentHi:  'oklch(0.70 0.140 250)',
    accentBg:  'oklch(0.62 0.155 250 / 0.14)',
    primaryBtn:      'oklch(0.42 0.075 250)',
    primaryBtnHover: 'oklch(0.47 0.085 250)',
    primaryBtnText:  'oklch(0.95 0.006 250)',
    warn:      'oklch(0.78 0.130 85)',
    warnBg:    'oklch(0.78 0.130 85 / 0.10)',
    restoreText:        'oklch(0.82 0.09 70)',
    restoreBorder:      'oklch(0.68 0.10 70 / 0.40)',
    restoreBorderHover: 'oklch(0.68 0.10 70 / 0.60)',
    restoreBg:          'oklch(0.70 0.12 70 / 0.08)',
    restoreBgHover:     'oklch(0.70 0.12 70 / 0.15)',
    danger:    'oklch(0.68 0.170 25)',
    dangerBg:  'oklch(0.68 0.170 25 / 0.10)',
    dangerBgHover: 'oklch(0.68 0.170 25 / 0.18)',
    /* Diff encoding — legend swatches, overlay boxes, and the injected
     * highlighter all read these so they cannot drift apart. */
    diffAdded:      'oklch(0.70 0.130 155)',
    diffAddedBg:    'oklch(0.70 0.130 155 / 0.18)',
    diffModified:   'oklch(0.78 0.130 85)',
    diffModifiedBg: 'oklch(0.78 0.130 85 / 0.18)',
    diffRemoved:    'oklch(0.68 0.150 25)',
    diffRemovedBg:  'oklch(0.68 0.150 25 / 0.18)',
    modalBody:      'oklch(0.135 0.008 250)',
    /* SPL syntax highlighting. Hues match the ko_viewer viz stylesheet so the
     * same search reads the same way in the record card and in the wrapper. */
    splCmd:    'oklch(0.74 0.10 205)',
    splFn:     'oklch(0.72 0.13 305)',
    splKw:     'oklch(0.78 0.13 75)',
    splStr:    'oklch(0.72 0.12 20)',
    splNum:    'oklch(0.76 0.10 155)',
};
module.exports = PAL;
