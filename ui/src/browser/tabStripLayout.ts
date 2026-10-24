/* Titles compact before actions. Once icon tabs no longer fit, the
   full switcher owns the remainder instead of clipping close buttons. */
export type TabStripLayout = {
  visibleIds: number[];
  hidden: number;
  tier: "normal" | "compact" | "icons";
  activeWidth: number;
  inactiveWidth: number;
};

export function tabStripLayout(ids: number[], activeId: number, width: number): TabStripLayout {
  const available = Math.max(0, width - 12);
  const activeWidth = Math.min(188, Math.max(148, available * 0.55));
  const activeIndex = Math.max(0, ids.indexOf(activeId));
  const count = ids.length;
  const fits = (inactive: number) => activeWidth + (count - 1) * inactive + Math.max(0, count - 1) * 4 <= available;
  let tier: TabStripLayout["tier"] = "normal";
  let inactiveWidth = 156;
  if (!fits(inactiveWidth)) { tier = "compact"; inactiveWidth = 112; }
  if (!fits(inactiveWidth)) { tier = "icons"; inactiveWidth = 80; }
  let visibleCount = count;
  let shownActiveWidth = Math.min(activeWidth, available);
  if (!fits(inactiveWidth)) {
    shownActiveWidth = Math.min(activeWidth, Math.max(0, available - 48));
    visibleCount = Math.min(count, Math.max(1, 1 + Math.floor((available - shownActiveWidth - 48) / (inactiveWidth + 4))));
  }
  const first = Math.min(Math.max(0, activeIndex - Math.floor((visibleCount - 1) / 2)), Math.max(0, count - visibleCount));
  return {
    visibleIds: ids.slice(first, first + visibleCount),
    hidden: count - visibleCount,
    tier,
    activeWidth: shownActiveWidth,
    inactiveWidth,
  };
}
