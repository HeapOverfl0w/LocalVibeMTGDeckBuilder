// ---------------------------------------------------------------------------
// ContextMenu (Phase 7, Step 7.1) — a small custom context menu rendered at
// the cursor. Closes on outside click, Escape, or after choosing an item.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 170; // approximate, for viewport clamping
const ITEM_HEIGHT = 34;

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // Keep the menu inside the viewport.
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 12));

  return (
    <div className="context-menu" ref={ref} style={{ left, top }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
