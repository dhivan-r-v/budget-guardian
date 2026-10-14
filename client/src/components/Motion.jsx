import { useEffect, useRef, useState } from 'react';

// No counting when the user asked for less motion, or when the page isn't visible: browsers
// pause animation frames in background tabs, which would leave the number stuck at its start.
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden');

// Eases a number from its previous value (0 on first render) to `value` over `ms`.
// Screen readers get the final value only; the ticking digits are hidden from them.
export function CountUp({ value, format, ms = 600 }) {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) {
      setShown(value);
      from.current = value;
      return undefined;
    }
    const start = performance.now();
    const begin = from.current;
    let frame;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      setShown(Math.round(begin + (value - begin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      from.current = value;
    };
  }, [value, ms]);
  return (
    <>
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

// Ids that were not in the previous list (none on the first render), for a brief highlight.
export function useNewIds(items) {
  const seen = useRef(null);
  const ids = items.map((i) => i.id);
  const fresh = seen.current ? new Set(ids.filter((id) => !seen.current.has(id))) : new Set();
  useEffect(() => {
    seen.current = new Set(ids);
  });
  return fresh;
}
