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

const prefersStill = () =>
  typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || window.matchMedia?.('(hover: none)').matches;

// Tilts an element toward the pointer and moves its sheen (--rx, --ry, --mx, --my).
// Off for touch screens and reduced motion.
export function useTilt(maxDeg = 7) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersStill()) return undefined;
    let frame = 0;
    const move = (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        el.classList.add('tilting');
        el.style.setProperty('--rx', `${((0.5 - y) * maxDeg).toFixed(2)}deg`);
        el.style.setProperty('--ry', `${((x - 0.5) * maxDeg * 1.3).toFixed(2)}deg`);
        el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
        el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
      });
    };
    const leave = () => {
      cancelAnimationFrame(frame);
      el.classList.remove('tilting');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [maxDeg]);
  return ref;
}

// Elements with class "reveal" rise into view as they scroll in, in order. Call after the
// content has rendered; anything already revealed stays revealed.
export function useReveal(deps) {
  useEffect(() => {
    const els = [...document.querySelectorAll('.reveal:not(.in)')];
    if (!('IntersectionObserver' in window) || prefersStill()) {
      els.forEach((el) => el.classList.add('in'));
      return undefined;
    }
    let order = 0;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.setProperty('--i', String(order++ % 4));
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
      order = 0;
    }, { rootMargin: '0px 0px -8% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, deps);
}

// A small burst of sparks, for moments worth celebrating (money moved to savings).
export function Burst({ count = 18 }) {
  return (
    <span className="burst" aria-hidden="true">
      {Array.from({ length: count }, (_, n) => (
        <i key={n} style={{ '--n': n, '--a': `${(360 / count) * n + (n % 2) * 9}deg`, '--d': `${38 + (n % 5) * 9}px` }} />
      ))}
    </span>
  );
}
