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
- Phase 2 (shipped, 98752a0): typography. All 11px sites ->
  --md-sys-typescale-label-small-font-size, 12px -> body-small, 14px ->
  body-medium (32 sites, pixel-identical). Deliberate exceptions, kept raw and
  documented in-file: 13px (9 sites, M3 has no 13) and 15px/16px glyph sizes.
  font-weight/line-height/tracking stay raw this pass; full role adoption is a
  later design call.
- Phase 3 (shipped, f2bc205): motion. Every duration literal -> nearest
  --md-sys-motion-duration-* token (exact for 150/200/250/300/400ms; deltas of
  10-30ms for 120/140/160/180/240/260/320ms), cubic-bezier(0.2,0,0,1) ->
  --md-sys-motion-easing-emphasized (exact), bare ease/ease-out ->
  easing-standard / easing-standard-decelerate. The --m3e-spring alias is
  re-pointed to the M3E spring-spatial control points (0.27, 1.06, 0.18, 1.0):
  the spring TOKENS bundle a duration so they cannot drop into an easing slot,
  the alias carries the curve only, and the old stronger homemade bounce is
  retired. Hover/press feel is slightly gentler.
- Phase 4 (shipped, c3863e4): shape + elevation. All five --m3e-shape-* aliases
  re-pointed 1:1 to corner tokens (xl=extra-large 28, lg=large-increased 20,
  md=large 16, sm=medium 12, xs=small 8; pixel-identical; the earlier phase-4
  prediction of lg->16/md->12 deltas was wrong, large-increased=20 covers lg),
  all nine 999px pills -> --md-sys-shape-corner-full, all six box-shadows ->
  --md-sys-elevation-level5 (hero floats) / level3 (toast, ext panel) with the
  old custom shadows as fallbacks. Elevation is the one real visual change:
  shadows are now theme-tinted (color-mix over the shadow color token) and
  M3E-scaled.

Post-ship correction (b3f1b4e): the phase-2 replacement dropped the
trailing semicolon on all 32 tokenized font-size declarations, so they
parsed as invalid and fell back to inherited sizes (the badge rendered at
22px instead of 11px). Caught by the live computed-style check, fixed, and
re-verified on the deploy. Lesson recorded: anchor-based CSS edits must
assert the full declaration including punctuation, and the live
computed-style check is not optional.

Verification: phases 2 and 4 are pixel-identical by construction (token value
== previous literal, verified against the @m3e/web dist defaults). Phase 3
changes pacing by at most 30ms per transition and the spring curve; phase 4
changes shadow geometry. CI + Render build are the compile gates; computed-style
checks run on the Preview deploy after it goes live.
