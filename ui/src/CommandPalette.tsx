import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import EmptyState from "./components/ui/EmptyState";

export type Command = {
  id: string;
  label: string;
  group: string;
  /* Optional second-Enter confirmation prompt for destructive
     commands (#81: no destructive action runs on a single Enter). */
  confirm?: string;
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
  const [pending, setPending] = useState<string | null>(null);

  /* Reset on every open. Escape is handled on window, not only on the
     input: a focus steal (engine-update snackbar etc.) must not leave
     a keyboard-trapped overlay. Focus itself is autoFocus on the
     input, so first keystrokes cannot race a timeout. */
  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    setPending(null);
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
  const pendingCmd = hits.find((c) => c.id === pending);

  const run = (i: number) => {
    const c = hits[i];
    if (!c) return;
    if (c.confirm && pending !== c.id) {
      setPending(c.id);
      return;
    }
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
      setPending(null);
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
        <input
          autoFocus={true}
          className="lb-cmdk-input"
          placeholder="Type a command..."
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
            setPending(null);
          }}
          onKeyDown={onKey}
        />
        <div className="lb-cmdk-list" role="listbox">
          {hits.length === 0 && (
            <EmptyState
              icon="search"
              headline="No matching command"
              help="Try a different term."
              action={{ label: "Clear search", onClick: () => setQ("") }}
            />
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
        <div className="lb-cmdk-hint">
          {pendingCmd ? pendingCmd.confirm : "Up/Down move, Enter runs, Esc closes"}
        </div>
      </div>
    </div>
  );
}
