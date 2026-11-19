import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePhoneLayout } from '@/lib/viewport';

export type MenuPlacement = 'above-start' | 'above-end' | 'below-end';

interface MenuProps {
  /** The element the menu opens from. */
  anchor: HTMLElement;
  placement?: MenuPlacement;
  onClose: () => void;
  label: string;
  /** At least as wide as the anchor (a pop-up button's menu). */
  matchWidth?: boolean;
  children: ReactNode;
}

/**
 * Apple's contextual menu (report §8): a glass panel, 185px minimum, 13px
 * items, hairline separators, red for destructive items. Closes on Escape, a
 * click outside, or a scroll of the page under it.
 *
 * On a phone it is the action sheet instead, as Apple's is: the same items
 * full-width, rising from the bottom over a scrim, with a Cancel row. A popover
 * pinned to a 30px ⋯ button is a desktop gesture; a thumb can't hit it and the
 * `pointerdown` scrim under it would fire before a tap landed.
 */
export function Menu({ anchor, placement = 'below-end', onClose, label, matchWidth, children }: MenuProps) {
  const phone = usePhoneLayout();
  if (phone) return <ActionSheet onClose={onClose} label={label}>{children}</ActionSheet>;
  return <PopoverMenu anchor={anchor} placement={placement} onClose={onClose} label={label} matchWidth={matchWidth}>{children}</PopoverMenu>;
}

const scrollLock = 'overflow-hidden';

/** The phone's menu: a sheet from the bottom, `role="menu"`, with Cancel. */
function ActionSheet({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  // The page under the sheet holds still, as iOS's does.
  useEffect(() => {
    const previous = document.body.className;
    document.body.classList.add(scrollLock);
    return () => {
      document.body.className = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[calc(var(--z-contextual-menus)-1)] animate-fade bg-[#00000059]"
        onPointerDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        className="fixed inset-x-0 bottom-0 z-(--z-contextual-menus) max-h-[80dvh] animate-sheet-in overflow-y-auto rounded-t-[16px] bg-page pb-[calc(env(safe-area-inset-bottom)+8px)] shadow-[0_-1px_0_var(--vibrantDivider),0_-20px_60px_#00000040] motion-reduce:animate-none"
        role="menu"
        aria-label={label}
      >
        <div className="mx-auto mt-2 mb-1 h-1 w-9 rounded-full bg-tertiary" aria-hidden="true" />
        <div className="px-4 pt-1 pb-2 type-title-3-emphasized">{label}</div>
        <div className="px-2">{children}</div>
        <div className="mx-2 mt-2 border-t-[0.5px] border-t-vibrant-divider" role="separator" />
        <button
          className="mt-1 w-full rounded-[10px] px-4 py-3 text-start type-title-3 text-key active:bg-quinary"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </>,
    document.body,
  );
}

function PopoverMenu({ anchor, placement, onClose, label, matchWidth, children }: MenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const width = matchWidth ? { minWidth: rect.width } : {};
    const above = { bottom: window.innerHeight - rect.top + gap, maxHeight: rect.top - 2 * gap, ...width };
    setPosition(
      placement === 'above-start'
        ? { left: Math.max(8, rect.left), ...above }
        : placement === 'above-end'
          ? { right: Math.max(8, window.innerWidth - rect.right), ...above }
          : {
              right: Math.max(8, window.innerWidth - rect.right),
              top: rect.bottom + gap,
              maxHeight: window.innerHeight - rect.bottom - 2 * gap,
              ...width,
            },
    );
  }, [anchor, placement, matchWidth]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        anchor.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        items[(next + items.length) % items.length]?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[calc(var(--z-contextual-menus)-1)]" onPointerDown={onClose} aria-hidden="true" />
      <div
        ref={panel}
        // Apple's amp-contextual-menu (report §8).
        className="fixed z-(--z-contextual-menus) max-w-[300px] min-w-[185px] animate-menu-in overflow-y-auto rounded-[10px] bg-thick-material p-[5px] shadow-[0_0_0_0.5px_var(--vibrantDivider),0_10px_40px_var(--glassMaterialShadowColor)] [backdrop-filter:saturate(2.2)_blur(32px)]"
        style={position}
        role="menu"
        aria-label={label}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

interface MenuItemProps {
  onSelect: () => void;
  icon?: ReactNode;
  /** Shows a checkmark (a radio-style choice); null leaves the space empty. */
  checked?: boolean | null;
  destructive?: boolean;
  disabled?: boolean;
  /** Extra text at the trailing edge. */
  trailing?: ReactNode;
  children: ReactNode;
}

export function MenuItem({ onSelect, icon, checked, destructive, disabled, trailing, children }: MenuItemProps) {
  return (
    <button
      className="flex min-h-7 w-full items-center gap-2 rounded-[5px] px-2 py-1 text-start type-body text-primary enabled:hover:bg-quinary focus-visible:bg-quinary disabled:text-tertiary data-destructive:text-destructive max-md:min-h-11 max-md:px-2.5 max-md:type-title-3 max-md:active:bg-quinary"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked === undefined ? undefined : !!checked}
      data-destructive={destructive || undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {checked !== undefined && <span className="inline-grid w-3.5 flex-none place-items-center text-key">{checked && <Check size={14} strokeWidth={2.6} />}</span>}
      {icon && <span className="inline-grid w-5 flex-none place-items-center text-secondary">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="flex-none text-secondary">{trailing}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="mx-2 my-[5px] border-t-[0.5px] border-t-vibrant-divider" role="separator" />;
}

/** A non-interactive heading inside a menu. */
export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 type-subhead-emphasized text-secondary">{children}</div>;
}
