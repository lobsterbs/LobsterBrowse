# LobsterBrowse UI

Material 3 Expressive shell built with @m3e/web + @m3e/react (matraic/m3e, MIT).

## Develop

    npm install
    npm run dev   # http://localhost:4141

## Notes

- M3E components are imported once via `@m3e/web/all`; React code treats them
  as host elements (`<m3-filled-button>` etc.) until @m3e/react typed wrappers
  are wired in.
- Theming: `src/theme.css` overrides the `--md-sys-*` system tokens (light/dark).
  Dynamic color will derive these tokens at runtime from a user seed color.
- Custom-element JSX intrinsics need `src/m3e.d.ts` once the exact element names
  are confirmed against the M3E Custom Elements Manifest.
