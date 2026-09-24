/* JSX intrinsics for M3E web components.
   Element names/attributes verified against https://matraic.github.io/m3e.
   React 18 + jsx:react-jsx resolves IntrinsicElements from React.JSX,
   so we augment that namespace rather than the global one. */
import type * as React from "react";

type M3eBase = {
  style?: React.CSSProperties;
  className?: string;
  slot?: string;
  key?: React.Key;
  children?: React.ReactNode;
  onClick?: (event: React.MouseEvent) => void;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "m3e-theme": M3eBase & { color?: string; "strong-focus"?: boolean };
      "m3e-content-pane": M3eBase;
      "m3e-heading": M3eBase & { variant?: string; size?: string; level?: number };
      "m3e-button": M3eBase & { variant?: string; shape?: string; size?: string; disabled?: boolean };
      "m3e-icon-button": M3eBase & { variant?: string; disabled?: boolean; toggle?: boolean | string };
      "m3e-icon": M3eBase & { name?: string };
      "m3e-card": M3eBase & { variant?: string };
      "m3e-switch": M3eBase & { checked?: boolean | string; icons?: string; disabled?: boolean };
      "m3e-radio-group": M3eBase;
      "m3e-radio": M3eBase & { value?: string; checked?: boolean | string; disabled?: boolean };
      "m3e-form-field": M3eBase & { variant?: string; "float-label"?: string };
      "m3e-chip-set": M3eBase & { vertical?: boolean };
      "m3e-chip": M3eBase & { variant?: string };
      "m3e-list": M3eBase;
      "m3e-list-item": M3eBase;
      "m3e-nav-menu": M3eBase;
      "m3e-nav-menu-item": M3eBase & { open?: boolean };
      "m3e-nav-rail": M3eBase & { mode?: string };
      "m3e-nav-item": M3eBase & { selected?: boolean | string; disabled?: boolean; href?: string };
      "m3e-nav-rail-toggle": M3eBase & { for?: string };
      "m3e-tabs": M3eBase;
      "m3e-tab": M3eBase & { for?: string; selected?: boolean };
      "m3e-tab-panel": M3eBase & { id?: string };
      "m3e-slider": M3eBase & { min?: string | number; max?: string | number; step?: string | number };
      "m3e-slider-thumb": M3eBase & { value?: string | number };
      "m3e-divider": M3eBase;
    }
  }
}
