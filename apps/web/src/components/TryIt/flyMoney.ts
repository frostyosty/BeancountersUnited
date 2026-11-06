/**
 * The "you saved tax" flourish: coins fly from where the visitor just clicked into the money bag
 * on the See your tax step, and the bag shakes as they land. Pure DOM + Web Animations, so it needs
 * no wiring between components; the bag is whatever carries `data-money-bag`.
 */

export interface Point {
  x: number;
  y: number;
}

/** Where the visitor last clicked or pressed Enter/Space, so the coins start from their answer. */
let lastAction: { at: number; point: Point } | null = null;
const ACTION_FRESH_MS = 10_000;

export function noteAction(ev: Event) {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  const r = target.getBoundingClientRect();
  const mouse = ev as MouseEvent;
  const usePointer =
    typeof mouse.clientX === "number" &&
    (mouse.clientX !== 0 || mouse.clientY !== 0);
  lastAction = {
    at: Date.now(),
    point: usePointer
      ? { x: mouse.clientX, y: mouse.clientY }
      : { x: r.left + r.width / 2, y: r.top + r.height / 2 },
  };
}

export function recentAction(): Point | null {
  return lastAction && Date.now() - lastAction.at < ACTION_FRESH_MS
    ? lastAction.point
    : null;
}

/** Fewer coins for a small saving, more for a big one, never a flood. */
export function coinCount(savedCents: number): number {
  return Math.max(3, Math.min(24, Math.round(savedCents / 5000)));
}

/** Splits `total` into `n` whole-cent shares that add back to exactly `total`. */
export function shares(total: number, n: number): number[] {
  const base = Math.trunc(total / n);
  const out = Array<number>(n).fill(base);
  out[n - 1] += total - base * n;
  return out;
}

const COIN_MS = 750;
const STAGGER_MS = 70;

/** True when this browser can run the animation at all (jsdom can't). */
export function canFly(): boolean {
  return (
    typeof Element !== "undefined" &&
    typeof Element.prototype.animate === "function"
  );
}

/**
 * Flies `count` coins from `from` into the money bag. `onLand(i)` runs as each coin arrives;
 * `onDone` once the last has. Returns a cancel function that finishes everything at once.
 */
export function flyMoney(
  from: Point,
  count: number,
  onLand: (i: number) => void,
  onDone: () => void,
): () => void {
  const bag = document.querySelector<HTMLElement>("[data-money-bag]");
  if (!bag || !canFly()) {
    for (let i = 0; i < count; i++) onLand(i);
    onDone();
    return () => {};
  }
  const coins: HTMLElement[] = [];
  let landed = 0;
  let cancelled = false;

  const land = (i: number) => {
    if (cancelled) return;
    onLand(i);
    landed++;
    bag.animate(
      [
        { transform: "translate(0, 0) rotate(0)" },
        { transform: "translate(-3px, 1px) rotate(-8deg)" },
        { transform: "translate(3px, -1px) rotate(8deg)" },
        { transform: "translate(-2px, 0) rotate(-5deg)" },
        { transform: "translate(0, 0) rotate(0)" },
      ],
      { duration: 220 },
    );
    if (landed === count) onDone();
  };

  const launch = () => {
    if (cancelled) return;
    const b = bag.getBoundingClientRect();
    const to = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    for (let i = 0; i < count; i++) {
      const coin = document.createElement("span");
      coin.textContent = "🪙";
      coin.setAttribute("aria-hidden", "true");
      Object.assign(coin.style, {
        position: "fixed",
        left: "0",
        top: "0",
        zIndex: "1000",
        pointerEvents: "none",
        fontSize: "1.3rem",
        willChange: "transform, opacity",
      });
      document.body.appendChild(coin);
      coins.push(coin);
      // Each coin arcs a little differently, so they scatter rather than march in a line.
      const jitterX = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const jitterY = (Math.cos(i * 78.233) * 12345.6789) % 1;
      const mid = {
        x: (from.x + to.x) / 2 + jitterX * 90,
        y: Math.min(from.y, to.y) - 40 - Math.abs(jitterY) * 70,
      };
      const at = (p: Point, scale: number) =>
        `translate(${p.x - 10}px, ${p.y - 10}px) scale(${scale})`;
      const anim = coin.animate(
        [
          { transform: at(from, 0.6), opacity: 0 },
          { transform: at(mid, 1.1), opacity: 1, offset: 0.45 },
          { transform: at(to, 0.5), opacity: 1 },
        ],
        {
          duration: COIN_MS,
          delay: i * STAGGER_MS,
          easing: "ease-in",
          fill: "both",
        },
      );
      anim.finished
        .catch(() => undefined)
        .then(() => {
          coin.remove();
          land(i);
        });
    }
  };

  // A bag that is still sliding into place is waited for, so the coins aim at where it will rest.
  const sliding =
    (bag.closest("[data-slide]") as HTMLElement | null)
      ?.getAnimations?.()
      .filter((a) => a.playState === "running") ?? [];
  if (sliding.length > 0)
    void Promise.all(
      sliding.map((a) => a.finished.catch(() => undefined)),
    ).then(launch);
  else launch();

  return () => {
    cancelled = true;
    coins.forEach((c) => c.remove());
    onDone();
  };
}
