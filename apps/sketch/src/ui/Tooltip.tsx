import { useEffect, useState } from 'preact/hooks';

/**
 * One shared tooltip for everything with a `data-tip` attribute (and `data-keys` for its shortcut).
 * It shows after a short pause, like Windows tooltips, and hides on press or when the mouse leaves.
 */
export function Tooltip() {
  const [tip, setTip] = useState<{ text: string; keys: string; x: number; y: number; place: 'right' | 'below' | 'above' } | null>(null);

  useEffect(() => {
    let timer = 0;
    let target: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      if (el === target) return;
      hide();
      if (!el || e.buttons) return;
      target = el;
      timer = window.setTimeout(() => {
        if (!target?.isConnected) return;
        const r = target.getBoundingClientRect();
        // Rail buttons get their tip to the right; everything else below, or above near the bottom.
        const place = target.dataset.tipSide === 'right' ? 'right' : r.bottom + 40 < window.innerHeight ? 'below' : 'above';
        setTip({
          text: target.dataset.tip ?? '',
          keys: target.dataset.keys ?? '',
          place,
          x: place === 'right' ? r.right + 8 : r.left + r.width / 2,
          y: place === 'right' ? r.top + r.height / 2 : place === 'below' ? r.bottom + 6 : r.top - 6,
        });
      }, 450);
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  if (!tip || !tip.text) return null;
  return (
    <div class={`tooltip ${tip.place}`} style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="tooltip">
      {tip.text}
      {tip.keys && <span class="tip-keys">{tip.keys}</span>}
    </div>
  );
}
