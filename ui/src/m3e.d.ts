/* JSX intrinsics for M3E web components.
   Element names/attributes verified against https://matraic.github.io/m3e.
   React 18 + jsx:react-jsx resolves IntrinsicElements from React.JSX,
   so we augment that namespace rather than the global one. */
import type * as React from "react";

type M3eBase = {
  style?: React.CSSProperties;
  className?: string;
  id?: string;
  slot?: string;
  key?: React.Key;
  children?: React.ReactNode;
  onClick?: (event: React.MouseEvent) => void;
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "m3e-theme": M3eBase & { color?: string; "strong-focus"?: boolean };
      "m3e-content-pane": M3eBase;
      "m3e-app-bar": M3eBase & { size?: string; centered?: boolean | string; for?: string };
      "m3e-avatar": M3eBase;
      "m3e-search-bar": M3eBase & { clearable?: boolean | string };
      "m3e-search-view": M3eBase & { mode?: string; contained?: boolean | string; "hide-search-icon"?: boolean | string };
      "m3e-heading": M3eBase & { variant?: string; size?: string; level?: number };
      "m3e-button": M3eBase & { variant?: string; shape?: string; size?: string; disabled?: boolean };
      "m3e-button-segment": M3eBase & { checked?: boolean | string; value?: string; disabled?: boolean };
      "m3e-segmented-button": M3eBase & { multi?: boolean | string; disabled?: boolean };
      "m3e-icon-button": M3eBase & { variant?: string; disabled?: boolean; toggle?: boolean | string; selected?: boolean | string; width?: string };
      "m3e-icon": M3eBase & { name?: string; filled?: boolean | string };
      "m3e-card": M3eBase & { variant?: string };
      "m3e-switch": M3eBase & { checked?: boolean | string; icons?: string; disabled?: boolean };
      "m3e-radio-group": M3eBase;
      "m3e-radio": M3eBase & { value?: string; checked?: boolean | string; disabled?: boolean };
      "m3e-form-field": M3eBase & { variant?: string; "float-label"?: string };
      "m3e-chip-set": M3eBase & { vertical?: boolean };
      "m3e-chip": M3eBase & { variant?: string; selected?: boolean | string };
      "m3e-list": M3eBase;
      "m3e-list-item": M3eBase;
      "m3e-nav-menu": M3eBase;
      "m3e-nav-menu-item": M3eBase & { open?: boolean };
      "m3e-nav-rail": M3eBase & { mode?: string };
      "m3e-nav-item": M3eBase & { selected?: boolean | string; disabled?: boolean; href?: string };
      "m3e-nav-rail-toggle": M3eBase & { for?: string };
      "m3e-expansion-panel": M3eBase & {
        open?: boolean | string;
        "hide-toggle"?: boolean | string;
        "toggle-position"?: string;
        "toggle-direction"?: string;
      };
      "m3e-accordion": M3eBase & { multi?: boolean | string };
      "m3e-tooltip": M3eBase & {
        for?: string;
        position?: string;
        "show-delay"?: string | number;
        "hide-delay"?: string | number;
        disabled?: boolean;
      };
      "m3e-badge": M3eBase & { for?: string; size?: string; position?: string };
      "m3e-loading-indicator": M3eBase & { variant?: string };
      "m3e-tabs": M3eBase & { variant?: string; stretch?: boolean | string; "header-position"?: string; "disable-pagination"?: boolean | string };
      "m3e-tab": M3eBase & { for?: string; selected?: boolean | string; disabled?: boolean };
      "m3e-tab-panel": M3eBase & { id?: string };
      "m3e-slider": M3eBase & { min?: string | number; max?: string | number; step?: string | number };
      "m3e-slider-thumb": M3eBase & { value?: string | number };
      "m3e-divider": M3eBase;
      "m3e-toolbar": M3eBase & {
        variant?: string;
        shape?: string;
        elevated?: boolean | string;
        vertical?: boolean | string;
      };
      "m3e-autocomplete": M3eBase & {
        for?: string;
        filter?: string;
        "case-sensitive"?: boolean | string;
        "no-data-label"?: string;
        "hide-no-data"?: boolean | string;
        loading?: boolean | string;
        "loading-label"?: string;
        "hide-loading"?: boolean | string;
        required?: boolean | string;
        "auto-activate"?: boolean | string;
      };
      "m3e-option": M3eBase & { value?: string; selected?: boolean | string; disabled?: boolean };
      "m3e-skeleton": M3eBase & {
        loaded?: boolean | string;
        shape?: string;
        animation?: string;
      };
      "m3e-dialog": M3eBase & {
        dismissible?: boolean | string;
        "close-label"?: string;
        "disable-close"?: boolean | string;
        "no-focus-trap"?: boolean | string;
        alert?: boolean | string;
      };
      "m3e-dialog-trigger": M3eBase & { for?: string };
      "m3e-menu": M3eBase & { variant?: string };
      "m3e-menu-trigger": M3eBase & { for?: string };
      "m3e-menu-item": M3eBase & { disabled?: boolean };
      "m3e-menu-item-checkbox": M3eBase & { checked?: boolean | string; disabled?: boolean };
      "m3e-menu-item-radio": M3eBase & { checked?: boolean | string; disabled?: boolean };
      "m3e-dialog-action": M3eBase & { "return-value"?: string };
      "m3e-fab": M3eBase & { size?: string; variant?: string };
    }
  }
}
