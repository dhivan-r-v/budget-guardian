// Simple line icons (24px grid, drawn with currentColor). No brand logos.
const PATHS = {
  fuel: (
    <>
      <path d="M4 20V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14" />
      <path d="M3 20h12" />
      <path d="M6.5 9h5" />
      <path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5.5" />
    </>
  ),
  entertainment: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
      <path d="M14 5v2M14 11v2M14 17v2" />
    </>
  ),
  food: (
    <>
      <path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3v3M12 3v3" />
    </>
  ),
  shopping: (
    <>
      <path d="M5 8h14l-1 12H6z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
  bills: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  transport: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 11h14M8 20v-3M16 20v-3" />
    </>
  ),
  other: <circle cx="12" cy="12" r="7" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  leaf: (
    <>
      <path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z" />
      <path d="M5 19l7-7" />
    </>
  ),
  bank: (
    <>
      <path d="M4 10l8-6 8 6" />
      <path d="M6 10v8M10 10v8M14 10v8M18 10v8M4 20h16" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.7-3.9L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 14.7 3.9l1.3-1.4" />
      <path d="M20 20v-4.5h-4.5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M16 14.5h2" />
    </>
  ),
  trend: (
    <>
      <path d="M4 16l5-5 4 4 7-7" />
      <path d="M15 8h5v5" />
    </>
  ),
};

export function Icon({ name, size = 20, className, title }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {PATHS[name] ?? PATHS.other}
    </svg>
  );
}

export const CategoryIcon = ({ category, size }) => (
  <span className="cat-icon" aria-hidden="true">
    <Icon name={PATHS[category] ? category : 'other'} size={size} />
  </span>
);
