/* Lazy xterm developer terminal (#45). xterm loads only when the
   DevTools terminal page is opened; ordinary browsing never pulls the
   chunk. Local diagnostics only - there is no shell and no remote
   execution surface; every engine reply passes the diagnostics
   sanitizer before it is printed. */
import { useEffect, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XFit } from "@xterm/addon-fit";
import { sanitizeText, sanitizeUrl } from "../sanitize";
import { zlSend } from "../zeolite";

export default function DevTerminal() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let dead = false;
    let term: XTerm | null = null;
    let fit: XFit | null = null;
    let ro: ResizeObserver | null = null;

    const out = (s: string) => { if (term && !dead) term.write(s); };
    const outLine = (s: string) => out(sanitizeText(s) + "\r\n");
    const outRawSanitized = (s: string) => out(sanitizeText(s) + "\r\n");
    const prompt = () => out("\x1b[36mzl\x1b[0m> ");
    const printJson = (label: string, v: unknown) => {
      let s: string;
      try { s = JSON.stringify(v, null, 2) ?? "undefined"; } catch { s = String(v); }
      outLine(label);
      outRawSanitized(s);
    };

    const run = async (raw: string) => {
      const line = raw.trim();
      if (!line) { prompt(); return; }
      if (line === "help") {
        outLine("zl:status    engine summary (extensions, downloads, transit)");
        outLine("zl:ping      engine round-trip latency");
        outLine("zl:transit   native vs rewrite-fallback routing counts");
        outLine("zl:netlog    latest transport fallback records");
        outLine("zl:ext [id]  extension list, or detail for one id");
        outLine("zl:downloads engine download registry");
        outLine("zl:storage   storage diagnostic (not exposed by the engine)");
        outLine("zl:workers   worker diagnostic (not exposed by the engine)");
        outLine("zl:clear     clear the terminal");
        prompt();
        return;
      }
      if (line === "zl:clear") { term?.clear(); prompt(); return; }
      if (line === "zl:ping") {
        const t0 = Date.now();
        const r = await zlSend({ type: "zl:getDiag", since: 0 }, 8000);
        outLine(r ? "engine replied in " + (Date.now() - t0) + " ms" : "engine unreachable (no reply within 8 s)");
        prompt();
        return;
      }
      if (line === "zl:status") {
        const [ext, dl, nl] = await Promise.all([
          zlSend({ type: "zl:listExt" }, 8000),
          zlSend({ type: "zl:downloads" }, 8000),
          zlSend({ type: "zl:getNetLog", since: 0 }, 8000),
        ]);
        const extList: unknown[] = Array.isArray(ext?.exts) ? ext.exts : [];
        const dlList: unknown[] = Array.isArray(dl?.downloads) ? dl.downloads : [];
        outLine("extensions: " + (ext ? String(extList.length) : "engine unreachable"));
        outLine("downloads in registry: " + (dl ? String(dlList.length) : "engine unreachable"));
        outLine("transit: " + (nl?.stats ? "native " + String(nl.stats.native) + ", fallback " + String(nl.stats.fallback) : "engine unreachable"));
        prompt();
        return;
      }
      if (line === "zl:transit" || line === "zl:netlog") {
        const nl = await zlSend({ type: "zl:getNetLog", since: 0 }, 8000);
        if (!nl?.stats) { outLine("engine unreachable"); prompt(); return; }
        const st = nl.stats as { native: number; fallback: number; fallbacks?: { ts: number; url: string; reason: string }[] };
        outLine("native transit: " + String(st.native) + "  rewrite fallbacks: " + String(st.fallback));
        if (line === "zl:netlog") {
          const fb = st.fallbacks ?? [];
          outLine(fb.length ? "latest fallback records:" : "no fallback records");
          for (const f of fb.slice(-10).reverse()) {
            outLine("  " + new Date(f.ts).toISOString().slice(11, 19) + "  " + sanitizeUrl(f.url) + "  (" + f.reason + ")");
          }
        }
        prompt();
        return;
      }
      if (line === "zl:ext" || line.startsWith("zl:ext ")) {
        const id = line.slice(7).trim();
        if (id) {
          const r = await zlSend({ type: "zl:extInfo", id }, 8000);
          printJson("extension " + id + ":", r);
        } else {
          const r = await zlSend({ type: "zl:listExt" }, 8000);
          const extList: { id?: string; name?: string; enabled?: boolean }[] = Array.isArray(r?.exts) ? r.exts : [];
          if (!r) outLine("engine unreachable");
          else if (!extList.length) outLine("no extensions installed");
          else for (const e of extList) outLine("  " + String(e.id ?? "?") + "  " + String(e.name ?? "?") + (e.enabled === false ? "  (disabled)" : ""));
        }
        prompt();
        return;
      }
      if (line === "zl:downloads") {
        const r = await zlSend({ type: "zl:downloads" }, 8000);
        const dlList: { filename?: string; status?: string; received?: number }[] = Array.isArray(r?.downloads) ? r.downloads : [];
        if (!r) outLine("engine unreachable");
        else if (!dlList.length) outLine("download registry empty");
        else for (const d of dlList) outLine("  " + String(d.filename ?? "?") + "  " + String(d.status ?? "?") + "  " + String(d.received ?? "?") + " bytes");
        prompt();
        return;
      }
      if (line === "zl:storage" || line === "zl:workers") {
        outLine(line + ": no such diagnostic surface in the engine control plane (honest no-op)");
        prompt();
        return;
      }
      outLine("unknown command: " + line + " - try help");
      prompt();
    };

    void (async () => {
      const mod = await import("@xterm/xterm");
      const fitMod = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      if (dead || !ref.current) return;
      term = new mod.Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, theme: { background: "#141218" } });
      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();
      ro = new ResizeObserver(() => { try { fit?.fit(); } catch { /* container hidden */ } });
      ro.observe(ref.current);
      let buf = "";
      const hist: string[] = [];
      let hi = -1;
      const redraw = (s: string) => { out("\r\x1b[K"); prompt(); out(s); };
      term.onData((d) => {
        if (d === "\r") {
          out("\r\n");
          const cmd = buf;
          buf = "";
          hi = -1;
          if (cmd.trim()) hist.push(cmd.slice(-400).trim());
          void run(cmd);
        } else if (d === "\x7f") {
          if (buf.length) { buf = buf.slice(0, -1); out("\b \b"); }
        } else if (d === "\x03") {
          out("^C\r\n");
          buf = "";
          prompt();
        } else if (d === "\x0c") {
          term?.clear();
          prompt();
        } else if (d === "\x1b[A") {
          if (hist.length) { hi = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1); buf = hist[hi]; redraw(buf); }
        } else if (d === "\x1b[B") {
          if (hi >= 0) { hi = hi + 1 >= hist.length ? -1 : hi + 1; buf = hi < 0 ? "" : hist[hi]; redraw(buf); }
        } else if (d >= " ") {
          buf += d;
          out(d);
        }
      });
      out("LobsterBrowse developer terminal - local diagnostics only.\r\n");
      out("No shell. Commands run against the engine control plane. Type help.\r\n\r\n");
      prompt();
    })();

    return () => { dead = true; ro?.disconnect(); term?.dispose(); };
  }, []);

  return <div ref={ref} className="lb-term" style={{ height: "300px", padding: "8px" }} aria-label="Developer terminal" />;
}
