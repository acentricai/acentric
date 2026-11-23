type GlyphProps = { readonly className?: string };

export function Check({ className = '' }: GlyphProps) {
  return (
    <svg className={`ac-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function Spinner({ className = '' }: GlyphProps) {
  return (
    <svg className={`ac-icon spinner ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}
