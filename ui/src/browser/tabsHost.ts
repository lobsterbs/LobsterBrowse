/* Zeolite extension tabs host (#701): the engine dispatches an
   extension's tabs.create() (the reported instance: Tampermonkey's
   options "Get some scripts..." link) as zl:tabsOp broadcasts to its
   UI window clients, and LB - owning the real tab model - opens the
   tab and syncs the authoritative list back over zl:tabs; the
   engine's tabs.ts syncFromUi resolves the pending create when the
   new tab carries the op nonce. Pure leaf module - no zeolite or
   store imports - so bare node can evaluate it
   (node --experimental-strip-types tests/tabs-host/check.mjs). */

export interface TabsCreateOp {
  nonce: string;
  url: string;
}

/* Trust boundary: the engine relays extension-supplied props and has
   already scheme-validated the URL (tabs.create rejects unsupported
   schemes), but a same-origin page can forge a container message
   event (see zeolite.ts engineSwSource's honest limit), so the host
   re-checks the shape and scheme and never navigates a tab anywhere
   but http(s)/ftp/file or a rooted engine-extension page (the
   zl:openExtPage granted-navigation shape with a live page token). */
export function parseTabsCreateOp(data: unknown): TabsCreateOp | null {
  if (!data || typeof data !== "object") return null;
  const d = data as {
    type?: unknown;
    op?: { op?: unknown; nonce?: unknown; props?: { url?: unknown } };
  };
  if (
    d.type !== "zl:tabsOp" ||
    !d.op ||
    d.op.op !== "create" ||
    typeof d.op.nonce !== "string" ||
    !d.op.nonce
  ) {
    return null;
  }
  const url = d.op.props?.url;
  if (typeof url !== "string" || !url) return null;
  if (!/^(https?|ftp|file):/i.test(url)) {
    /* Rooted engine-extension page only (the zl:openExtPage granted
       navigation shape with a live page token, mirroring extLaunch's
       extPageUrlOk; protocol-relative and backslash forms are
       off-origin forgeries). */
    if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) return null;
    const q = url.indexOf("?");
    if (q < 0) return null;
    const params = new URLSearchParams(url.slice(q + 1));
    if (params.get("zlExt") === null || params.get("zlPageTok") === null) return null;
  }
  return { nonce: d.op.nonce, url };
}

export interface UiTabSync {
  id: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  /** UI-set marker resolving a pending tabs.create() (Zeolite tabs.ts). */
  nonce?: string;
}

export function toTabsUi(
  tabs: ReadonlyArray<{ id: number; url: string; title: string }>,
  activeId: number,
  nonceOf: (id: number) => string | undefined,
): UiTabSync[] {
  return tabs.map((t, index) => {
    const sync: UiTabSync = {
      id: t.id,
      index,
      url: t.url,
      title: t.title,
      active: t.id === activeId,
    };
    const nonce = nonceOf(t.id);
    if (nonce) sync.nonce = nonce;
    return sync;
  });
}
