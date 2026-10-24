import assert from 'node:assert/strict';
import { tabStripLayout } from '../../ui/src/browser/tabStripLayout.ts';
let checked = 0;
for (const width of [240, 280, 304, 344, 400, 540, 720, 1024]) {
  for (const count of [1, 2, 3, 6, 10, 20, 50, 100]) {
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    for (const activeId of [ids[0], ids[Math.floor(count / 2)], ids.at(-1)]) {
      const layout = tabStripLayout(ids, activeId, width);
      assert(layout.visibleIds.includes(activeId), 'active tab remains visible');
      assert.deepEqual(layout.visibleIds, [...layout.visibleIds].sort((a,b) => a-b), 'original tab order survives');
      assert.equal(layout.visibleIds.length + layout.hidden, count);
      assert(layout.activeWidth >= 148, 'active title keeps space');
      assert(layout.inactiveWidth >= 80, 'favicon and close remain independent targets');
      const used = 12 + layout.activeWidth + (layout.visibleIds.length - 1) * (layout.inactiveWidth + 4) + (layout.hidden ? 48 : 0);
      assert(used <= width + 0.001, `strip overflow: ${width}px / ${count} tabs`);
      checked++;
    }
  }
}
assert.equal(tabStripLayout([1,2,3],2,720).tier, 'normal');
assert.equal(tabStripLayout([1,2,3],2,460).tier, 'compact');
assert.equal(tabStripLayout([1,2,3],2,380).tier, 'icons');
assert(tabStripLayout(Array.from({length:50},(_,i)=>i),25,304).hidden > 0, 'high-count overflow opens switcher');
console.log(`tab-strip check: ${checked} layouts ok`);
