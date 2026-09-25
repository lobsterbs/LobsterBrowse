/* LobsterJet DevTools page (Phase 4): network inspector. This page is
   served by the engine origin, so it is controlled by the same SW and
   can postMessage it. It polls lj:getNetLog once per second and keeps a
   stable sort. The network inspector is the priority deliverable; a
   DOM/CSS inspector over a postMessage bridge into proxied pages
   remains a stretch goal. */

interface NetEntry {
  seq: number;
  ts: number;
  method: string;
  path: string;
  dest: string;
  status: number;
  ms: number;
  err?: string;
}

const rows = document.getElementById("rows")!;
const paused = document.getElementById("paused")!;

let entries: NetEntry[] = [];
let sortKey: keyof NetEntry = "seq";
let sortDesc = false;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function render(): void {
  const sorted = [...entries].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
    return sortDesc ? -cmp : cmp;
  });
  rows.replaceChildren(
    ...sorted.map((e) => {
      const tr = document.createElement("tr");
      const cells = [
        fmtTime(e.ts),
        e.method,
        e.dest,
        String(e.status),
        String(e.ms),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        td.textContent = c;
        if (i === 2 && e.err) {
          td.className = "err";
          td.title = e.err;
          td.textContent = e.dest + " (error)";
        } else if (i === 3 && e.status >= 200) {
          td.className = `status-${Math.floor(e.status / 100)}`;
        }
        tr.appendChild(td);
      });
      return tr;
    }),
  );
}

// Column header sorting.
document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = (th as HTMLElement).dataset.sort as keyof NetEntry;
    if (key === sortKey) sortDesc = !sortDesc;
    else {
      sortKey = key;
      sortDesc = false;
    }
    render();
  });
});

function tick(): void {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) {
    paused.textContent = "waiting for the service worker... (open a proxied page first)";
    return;
  }
  paused.textContent = "";
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    const { entries: snap } = (ev.data ?? { entries: [] }) as { entries: NetEntry[] };
    if (snap.length !== entries.length || snap.at(-1)?.seq !== entries.at(-1)?.seq) {
      entries = snap;
      render();
    }
  };
  ctl.postMessage({ type: "lj:getNetLog" }, [ch.port2]);
}

tick();
setInterval(tick, 1000);
