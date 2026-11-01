import type { ReactNode } from "react";

const icon = (children: ReactNode, viewBox = "0 0 24 24") => (
  <svg
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icons = {
  search: icon(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>,
  ),
  dashboard: icon(
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 10h17M10 10v10.5" />
    </>,
  ),
  settings: icon(
    <>
      <path d="M10.3 4.3a1.7 1.7 0 0 1 3.4 0 1.7 1.7 0 0 0 2.6 1 1.7 1.7 0 0 1 2.4 2.4 1.7 1.7 0 0 0 1 2.6 1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0-1 2.6 1.7 1.7 0 0 1-2.4 2.4 1.7 1.7 0 0 0-2.6 1 1.7 1.7 0 0 1-3.4 0 1.7 1.7 0 0 0-2.6-1 1.7 1.7 0 0 1-2.4-2.4 1.7 1.7 0 0 0-1-2.6 1.7 1.7 0 0 1 0-3.4 1.7 1.7 0 0 0 1-2.6 1.7 1.7 0 0 1 2.4-2.4 1.7 1.7 0 0 0 2.6-1Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ),
  trash: icon(
    <>
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </>,
  ),
  lock: icon(
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
      <circle cx="12" cy="15.5" r="0.6" fill="currentColor" />
    </>,
  ),
  collection: icon(
    <>
      <rect x="4" y="4" width="14" height="14" rx="2" />
      <path d="M8 20.5h10a2.5 2.5 0 0 0 2.5-2.5V8" />
    </>,
  ),
  chevronLeft: icon(<path d="m15 5-7 7 7 7" />),
  chevronRight: icon(<path d="m9 5 7 7-7 7" />),
  chevronsUpDown: icon(<path d="m7 9 5-5 5 5M7 15l5 5 5-5" />),
  plus: icon(<path d="M12 5v14M5 12h14" />),
  sort: icon(
    <path d="M7 20V4M3.5 7.5 7 4l3.5 3.5M17 4v16M13.5 16.5 17 20l3.5-3.5" />,
  ),
  dots: icon(
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>,
  ),
  pencil: icon(<path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4Z" />),
  share: icon(
    <>
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1" />
    </>,
  ),
  imageExport: icon(
    <>
      <rect x="3.5" y="3.5" width="17" height="13" rx="2" />
      <circle cx="9" cy="8.5" r="1.5" />
      <path d="m20.5 13-4.5-4.5-8.5 8M5 20.5h.01M9 20.5h.01M13 20.5h.01M17 20.5h.01" />
    </>,
  ),
  pin: icon(
    <path d="M15 4.5 19.5 9l-3.5 1.5-3 3 .5 4-1.5 1.5-3.5-3.5L4 20l4.5-4.5L5 12l1.5-1.5 4 .5 3-3Z" />,
  ),
  duplicate: icon(
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </>,
  ),
  move: icon(
    <>
      <path d="M8 3.5h6.5L19 8v11a2 2 0 0 1-2 2H9" />
      <path d="M14 3.5V8h5M3.5 15H11M8 12l3 3-3 3" />
    </>,
  ),
  bell: icon(
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9" />
      <path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0" />
    </>,
  ),
  check: icon(<path d="m5 12.5 4.5 4.5L19 7.5" />),
  close: icon(<path d="M6 6l12 12M18 6 6 18" />),
  folder: icon(
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  ),
  importIcon: icon(<path d="M3.5 12H16M12 7.5l4.5 4.5L12 16.5M20.5 4.5v15" />),
  filePlus: icon(
    <>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
      <path d="M13.5 3.5V9H19" />
      <circle cx="9" cy="15.5" r="3.5" fill="currentColor" stroke="none" />
      <path d="M9 13.8v3.4M7.3 15.5h3.4" stroke="#232328" />
    </>,
  ),
  sidebar: icon(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M5.8 8.5h1.4M5.8 11h1.4" />
    </>,
  ),
  restore: icon(
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5" />
    </>,
  ),
  link: icon(
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>,
  ),
  file: icon(
    <>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z" />
      <path d="M13.5 3.5V9H19" />
    </>,
  ),
};
