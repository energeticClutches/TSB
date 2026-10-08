/**
 * Placeholder badge logo (from the Stitch export, with the clipped tagline fixed).
 * To be replaced by the traced poster logo once the owner shares the original file.
 */
export function Logo({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      role="img"
      aria-label="The Slush Bar"
      className={className}
    >
      <defs>
        <linearGradient id="slush-cup" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF2E93" />
          <stop offset="1" stopColor="#E6007A" />
        </linearGradient>
      </defs>
      <circle cx="120" cy="120" r="112" fill="#FFF5F8" stroke="#E6007A" strokeWidth="8" />
      <circle cx="120" cy="120" r="100" fill="none" stroke="#E6007A" strokeWidth="2" strokeDasharray="6 5" opacity="0.6" />
      <g transform="translate(120 98)">
        <path d="M-30 0 L-22 46 C-21 51 -15 55 -9 55 L9 55 C15 55 21 51 22 46 L30 0 Z" fill="url(#slush-cup)" />
        <path d="M-28 -2 C-28 -24 -15 -37 0 -37 C15 -37 28 -24 28 -2 Z" fill="#FF52AF" />
        <path d="M-19 -4 C-19 -21 -9 -30 0 -30 C9 -30 19 -21 19 -4 Z" fill="#FFE3F1" />
        <path d="M-2 -48 L20 -9 L13 -7 L-9 -46 Z" fill="#FFFFFF" stroke="#E6007A" strokeWidth="2" />
      </g>
      <text x="120" y="190" textAnchor="middle" fontFamily="Outfit Variable, Outfit, sans-serif" fontWeight="900" fontSize="34" fill="#E6007A">
        SLUSH
      </text>
    </svg>
  );
}
