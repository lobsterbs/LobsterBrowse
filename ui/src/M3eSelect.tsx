/* Shared m3e-select wrapper for React.
   React's synthetic onChange only fires on native form elements, so
   the component's change event is wired through a ref. Per the M3E
   docs the select's value attribute is the single source of
   selection state; option-level selected must not be combined with
   it. The value attribute is re-asserted after mount because custom
   element upgrade order relative to its children is not guaranteed. */
import { useEffect, useRef } from "react";

type M3eSelectProps = {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
};

export default function M3eSelect(props: M3eSelectProps) {
  const ref = useRef<HTMLElement & { value: string } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute("value", props.value);
    const handler = (e: Event) => {
      const target = e.target as HTMLElement & { value: string };
      props.onChange(String(target.value));
    };
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  });
  return (
    <m3e-select aria-label={props.label} value={props.value} {...{ ref }}>
      {props.options.map(([v, label]) => (
        <m3e-option key={v} value={v}>{label}</m3e-option>
      ))}
    </m3e-select>
  );
}
