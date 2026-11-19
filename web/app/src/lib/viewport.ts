import { useEffect, useState } from 'react';
import { isMobileBrowser } from './platform';

/** The width the phone chrome starts below; the same value as Tailwind's `md` (styles/global.css). */
export const PHONE_QUERY = '(max-width: 767px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

/**
 * Whether this is a phone layout right now.
 *
 * The width decides, not the user agent: a desktop window dragged narrow gets
 * the same chrome a phone does, and a tablet in landscape gets the desktop's.
 * `isMobileBrowser` is only consulted when the width is ambiguous (a small
 * window on a real desktop is still a desktop, but its chrome should be the
 * phone's, so width wins outright).
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => matches(PHONE_QUERY) || (isMobileBrowser() && !matches('(min-width: 768px)')));
  useEffect(() => {
    const list = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return phone;
}

/** The value right now, for code outside React. */
export function phoneLayoutSnapshot(): boolean {
  return matches(PHONE_QUERY);
}

/** Where hover doesn't exist: a finger's primary pointer. */
export const TOUCH_QUERY = '(hover: none), (pointer: coarse)';

/**
 * Whether the primary pointer can't hover. A phone or tablet gets rows that
 * answer a tap where a desktop's reveal a play button on hover, and menus
 * that are always shown rather than revealed.
 */
export function useTouchInput(): boolean {
  const [touch, setTouch] = useState(() => matches(TOUCH_QUERY));
  useEffect(() => {
    const list = window.matchMedia(TOUCH_QUERY);
    const update = () => setTouch(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return touch;
}
