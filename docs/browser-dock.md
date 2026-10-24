# Browser dock comparison

The single browser dock remains the default. Open the tab switcher and press
**Try split browser dock** to compare separate address and action surfaces.
**Use single browser dock** restores the original arrangement. The choice is
session-only; it is not a new persisted Settings migration.

Both arrangements use the same navigation handlers, editor, controls, tab
state, close animation and always-mounted preview switcher. The split version
keeps the editable URL in the identity pill while allowing its toolbar to size
independently from the action toolbar. On narrow screens the surfaces stack
and the action row wraps instead of squeezing or hiding controls. The tradeoff
is more vertical space while the dock is visible. Auto-hide and the reveal
grip work for the entire dock in either arrangement.

The older floating top tab strip had already been removed. The replacement
compact strip lives inside the action dock and appears when more than one tab
is open. It measures its actual available width with ResizeObserver:

- Normal: inactive tabs keep titles and favicons.
- Compact: inactive title space reduces before the active title does.
- Icons: inactive titles hide while favicon and close controls stay separate.
- When icon tabs do not fit, a **+N** button opens the complete preview switcher.

The active tab remains in the visible set even at high tab counts. Arrow keys,
Home and End on a tab selector move through the complete tab collection. The
close control is a separate native button; it does not select the tab. The
main strip does not scroll horizontally. Only the full preview collection
retains its existing horizontal scrolling.

Run the layout contract with:

```sh
node --experimental-strip-types tests/tab-strip/check.mjs
```

It covers 192 combinations of available width, tab count and active position.
