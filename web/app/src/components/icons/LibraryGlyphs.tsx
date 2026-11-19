// The phone Library tab's glyphs, drawn in a 24×24 box and filled with
// currentColor, in the key colour as Apple's Library shortcuts are. Each is
// the idea of its section rather than a copy of Apple's own drawing.

import type { SVGProps } from 'react';

type GlyphProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function make(children: React.ReactNode) {
  return function Glyph({ size = 24, ...props }: GlyphProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {children}
      </svg>
    );
  };
}

/** Recently Played: a clock. */
export const ClockGlyph = make(
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M12 7.5V12l3 1.8" />
  </>,
);

/** Songs: a heart. */
export const HeartGlyph = make(
  <path d="M12 19.3 5.9 13.2a3.9 3.9 0 0 1 0-5.5 3.9 3.9 0 0 1 5.5 0l.6.6.6-.6a3.9 3.9 0 0 1 5.5 5.5z" />,
);

/** Albums: a record. */
export const DialGlyph = make(
  <>
    <circle cx="12" cy="12" r="8.25" />
    <circle cx="12" cy="12" r="2.2" />
  </>,
);

/** Artists: a microphone stand, as the sidebar's Artists glyph. */
export const SparkGlyph = make(
  <>
    <path d="M9.2 4.6a3 3 0 0 1 4.2 0l1.6 1.6-4.2 4.2-1.6-1.6a3 3 0 0 1 0-4.2Z" />
    <path d="m10.8 10.4 1.8 1.8M8.6 12.6 6 15.2a1.6 1.6 0 0 0 0 2.2l.6.6a1.6 1.6 0 0 0 2.2 0l2.6-2.6" />
    <path d="m14.5 14 4.2-4.2" />
  </>,
);
