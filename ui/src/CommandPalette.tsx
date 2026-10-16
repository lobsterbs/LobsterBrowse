import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export type Command = {
  id: string;
  label: string;
  group: string;
  /* Destructive commands must not run from here directly: they open
     a confirmation dialog in the owner instead (App.tsx). */
  run: () => void;
};

type Props = {
  open: boolean;
  commands: Command[];
  onClose: () => void;
};

/* #81: dependency-free Ctrl+K command palette. Plain divs; all
   looks live in theme.css (.lb-cmdk*) against M3E tokens. Filtering
   is a substring match over label+group; arrows move, Enter runs,
   Esc closes. ponytail: substring match, not fuzzy scoring - the
   list is ~10 items. */
export default function CommandPalette({ open, commands, onClose }: Props) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  /* Reset on every open. Escape is handled on window, not only on the
     input: a focus steal (engine-update snackbar etc.) must not leave
     a keyboard-trapped overlay. Focus itself is autoFocus on the
     input, so first keystrokes cannot race a timeout. */
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    const onWin = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onWin);
    return () => window.removeEventListener("keydown", onWin);
  }, [open, onClose]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const hits = needle
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(needle) ||
          c.group.toLowerCase().includes(needle),
      )
    : commands;
  const sel = Math.min(idx, Math.max(hits.length - 1, 0));

  const run = (i: number) => {
    const c = hits[i];
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIdx((sel + d + hits.length) % hits.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  };

  return (
    <div
      className="lb-cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lb-cmdk" role="dialog" aria-label="Command palette">
        {/* #102: M3E search bar; the input is its slotted control. */}
        <m3e-search-bar>
          <input
            slot="input"
            autoFocus={true}
            aria-label="Type a command"
            placeholder="Type a command..."
            value={q}
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
          />
        </m3e-search-bar>
        <div className="lb-cmdk-list" role="listbox">
          {hits.length === 0 && (
            <div className="lb-cmdk-empty">No matching command</div>
          )}
          {hits.map((c, i) => {
            const head = i === 0 || hits[i - 1].group !== c.group;
            return (
              <div key={c.id}>
                {head && <div className="lb-cmdk-group">{c.group}</div>}
                <div
                  className={"lb-cmdk-item" + (i === sel ? " selected" : "")}
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(i);
                  }}
                >
                  {c.label}
                </div>
              </div>
            );
          })}
        </div>
        <div className="lb-cmdk-hint">Up/Down move, Enter runs, Esc closes</div>
      </div>
    </div>
  );
}
