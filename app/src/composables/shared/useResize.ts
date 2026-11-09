// Dragging the left edge of a pane on the right to resize it. The handle captures the pointer, so a release anywhere,
// outside the window too, ends the drag.
import type { Ref } from 'vue';

export function useResize(width: Ref<number>, opts: { min: number; max: () => number; onEnd: (width: number) => void }) {
  function startResize(down: PointerEvent) {
    const handle = down.currentTarget as HTMLElement;
    const startX = down.clientX;
    const startW = width.value;
    const move = (e: PointerEvent) => {
      width.value = Math.round(Math.min(Math.max(startW + startX - e.clientX, opts.min), opts.max()));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      opts.onEnd(width.value);
    };
    handle.setPointerCapture(down.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  }
  return { startResize };
}
