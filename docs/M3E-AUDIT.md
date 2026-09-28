# M3E compliance audit (Preview build)

Date: 2026-09-28. Scope: ui/src (all CSS + TSX) on beta/zeolite-nativetransit.
Reference: M3E v2.8.2 (matraic.github.io/m3e) and the @m3e/web 2.8.2 dist
(theme.js, core.js), which is the authority for token names and values.

Token families verified present in the dist: --md-sys-color-*, --md-sys-typescale-*
(15 roles x size/weight/line-height/tracking), --md-sys-shape-corner-*,
--md-sys-elevation-level0..5, --md-sys-motion-duration-* / easing-* / spring-*,
--md-sys-measurement-spaceN (spaceN = 8 * N/100 px: space100=8, space200=16,
space300=24, space600=48), --md-sys-density-scale/size, --md-sys-state-*-opacity.

## Compliant (no action)

- Component usage: all 26 m3e-* elements used are declared in ui/src/m3e.d.ts.
  No className on any m3e-* element (the React custom-element quirk is
  respected everywhere). No m3e-icon-button title props. m3e-theme is used for
  dynamic color.
- theme.css main chrome: 87 --md-sys-measurement-* uses; colors overwhelmingly
  through --md-sys-color-*.
- Settings seed colors are theme-engine inputs, not styling (fine).
- DevTools outline hex sits in a var() fallback (fine).

## Findings (non-compliant)

1. extensions.css used a nonexistent token prefix: --m3e-sys-color-* (3 uses).
   The dist defines --md-sys-color-* only, so the hardcoded dark-only fallbacks
   (#2b2b2b, #e6e1e5, #cfbfe0) always won and the extensions panel ignored the
   app theme entirely. FIXED in phase 1.
2. Typography: 47 font-size + font-weight/line-height declarations in
   theme.css and 7+ in extensions.css; zero use --md-sys-typescale-* tokens.
   Systemic; the app also overrides component font-family with Google Sans
   Flex, which is a deliberate brand choice, but sizes/weights/line-heights
   are untokenized.
3. Motion: ~20 hardcoded transition/animation durations and easings
   (250ms/180ms/150ms, cubic-bezier(0.2,0,0,1), ease...). The homemade
   --m3e-spring alias (cubic-bezier(0.34,1.3,0.64,1)) is used at 20 sites
   instead of --md-sys-motion-spring-*/duration-*/easing-*.
4. Shape: the :root alias layer --m3e-shape-{xl:28,lg:20,md:16,sm:12,xs:8}px
   predates the discovery that M3E DOES ship --md-sys-shape-corner-* tokens
   (extra-large=28, large=16, medium=12, small=8, extra-small=4). lg=20 and
   md=16 diverge from the spec scale. The old comment claiming "M3E ships no
   shape tokens" was false and is corrected. 999px pills exist where
   --md-sys-shape-corner-full would be the token.
5. Elevation: 7 raw box-shadow rgba() declarations (theme.css x6,
   extensions.css x1) instead of --md-sys-elevation-level*.
6. Status colors: .lb-tb-lock.secure #1e8e3e and (pre-fix) #d93025 hardcoded.
   Error reds moved to --md-sys-color-error in phase 1. Green stays raw: M3E
   has no success token; a deliberate exception until a decision is made.
7. Spacing residue: extensions.css had zero measurement tokens (~15 raw px
   paddings/margins), rail.css one, theme.css ~13. Fixed to tokens with
   pixel-identical fallbacks in phase 1. Remaining raw: rail.css
   m3e-nav-item margin 7px 0 (no space token equals 7px; space75=6px would
   tighten rail rhythm; left raw on purpose).
8. State layers: hover/code backgrounds were raw rgba(128,128,128,.15/.18)
   instead of color-mix over --md-sys-color-on-surface. Fixed in phase 1.

## Phase map

- Phase 1 (shipped, 4785917): mechanical, pixel-identical token migration.
  extensions.css token-prefix fix + spacing tokens; theme.css residual
  spacing tokens + error color tokens; rail.css padding token; hover/code
  backgrounds to color-mix; false shape-token comment corrected.
- Phase 2 (pending): typography. Map font-size/weight/line-height to
  --md-sys-typescale-* roles with current px fallbacks. Needs an eyeball
  pass per surface (home, browser chrome, settings, devtools) because typescale
  values differ from the current raw sizes; fallbacks keep the option of
  shipping token-first without visual change.
- Phase 3 (pending): motion. Re-point --m3e-spring to --md-sys-motion-spring-*
  and durations/easings to the duration/easing tokens, fallback-first so
  pacing is unchanged until the token values are verified visually.
- Phase 4 (pending): shape + elevation. Re-point the --m3e-shape-* aliases to
  --md-sys-shape-corner-* (visual deltas where values differ: lg 20->16,
  md 16->12), pills to corner-full, box-shadows to --md-sys-elevation-level*.
  Needs a real-browser eyeball pass after each deploy.

Verification for phase 1: pixel-identical by construction (every token carries
the exact previous px value as its fallback). CI + Render build are the
compile gates; live check on the Preview deploy after deploy completes.
