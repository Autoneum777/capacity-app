import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  text: string;
  children: ReactNode;
};

type TipPos = { top: number; left: number; maxHeight: number; width: number };

/**
 * Pełna lista detali przy najechaniu na kafelek obciążenia.
 * Native `title` ucina długie treści; portal + scroll pokazuje wszystkie pozycje.
 */
export default function CalcCellHoverTip({ text, children }: Props) {
  const tipId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TipPos | null>(null);

  const clearHide = () => {
    if (hideTimer.current != null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const show = useCallback(() => {
    clearHide();
    if (!text.trim()) return;
    setOpen(true);
  }, [text]);

  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => setOpen(false), 120);
  }, []);

  const updatePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(520, Math.max(280, window.innerWidth - margin * 2));
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const preferBelow = spaceBelow >= 160 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(520, Math.max(120, preferBelow ? spaceBelow : spaceAbove));
    let left = r.left + r.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const top = preferBelow ? r.bottom + 4 : Math.max(margin, r.top - 4 - maxHeight);
    setPos({ top, left, maxHeight, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, text, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePos();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updatePos]);

  useEffect(() => () => clearHide(), []);

  return (
    <div
      ref={anchorRef}
      className="calc-cell-hover-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
      aria-describedby={open ? tipId : undefined}
    >
      {children}
      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            className="calc-cell-hover-tip"
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            {text}
          </div>,
          document.body
        )}
    </div>
  );
}
