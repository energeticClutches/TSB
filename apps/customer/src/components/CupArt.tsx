import { imageUrl } from '../lib/env';

/** Product photo, or a flavour-tinted slush cup drawing when there's no photo yet. */
export function ProductImage({ image, accent, name, className }: { image: string | null; accent: string | null; name: string; className?: string }) {
  const src = imageUrl(image);
  const tint = accent ?? '#E6007A';
  return (
    <div className={className} style={{ background: `radial-gradient(circle at 50% 60%, ${tint}38, ${tint}10 60%, transparent 75%)` }}>
      {src ? (
        <img src={src} alt={name} loading="lazy" decoding="async" className="size-full object-cover" />
      ) : (
        <svg viewBox="0 0 100 100" className="size-full p-3" role="img" aria-label={name}>
          <path d="M26 42 L33 86 C34 90 37 92 41 92 L59 92 C63 92 66 90 67 86 L74 42 Z" fill={tint} opacity="0.9" />
          <path d="M24 41 C24 26 35 17 50 17 C65 17 76 26 76 41 Z" fill={tint} />
          <path d="M32 40 C32 30 40 24 50 24 C60 24 68 30 68 40 Z" fill="#fff" opacity="0.35" />
          <path d="M52 6 L64 36 L59 37 L47 8 Z" fill="#fff" stroke={tint} strokeWidth="1.5" />
        </svg>
      )}
    </div>
  );
}
