/* JSX intrinsics for M3E web components (element names/attributes verified
   against https://matraic.github.io/m3e docs). */
import "./types";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "m3e-theme": { color?: string; "strong-focus"?: boolean; children?: any };
      "m3e-content-pane": { children?: any; class?: string };
      "m3e-heading": { variant?: string; size?: string; level?: number; children?: any };
      "m3e-button": { variant?: string; shape?: string; size?: string; onClick?: any; disabled?: boolean; children?: any };
      "m3e-icon-button": { variant?: string; "aria-label"?: string; onClick?: any; children?: any };
      "m3e-icon": { name?: string; "aria-hidden"?: boolean };
      "m3e-card": { variant?: string; class?: string; children?: any };
      "m3e-switch": { checked?: any; icons?: string; onClick?: any; disabled?: any };
      "m3e-radio-group": { children?: any };
      "m3e-radio": { value?: string; checked?: any; onClick?: any };
      "m3e-form-field": { variant?: string; "float-label"?: string; children?: any };
      "m3e-chip-set": { vertical?: boolean; children?: any };
      "m3e-chip": { variant?: string; children?: any };
      "m3e-list": { children?: any };
      "m3e-list-item": { children?: any };
      "m3e-nav-menu": { children?: any };
      "m3e-nav-menu-item": { open?: boolean; onClick?: any; children?: any };
      "m3e-tabs": { children?: any };
      "m3e-tab": { for?: string; selected?: boolean; children?: any };
      "m3e-tab-panel": { id?: string; children?: any };
      "m3e-slider": { min?: string; max?: string; step?: string; children?: any };
      "m3e-slider-thumb": { value?: string };
      "m3e-divider": any;
      "m3e-snackbar": any;
    }
  }
}

export {};