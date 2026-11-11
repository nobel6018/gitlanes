// 이모지와 글리프 아이콘을 대신하는 SVG 아이콘. Toolbar.tsx 아이콘과 같은 규격:
// viewBox 16, stroke 1.4, currentColor, aria-hidden (옆에 항상 글자 라벨이 있다).
// @see docs/design-system.md

import type { ReactElement } from "react";

interface IconProps {
  size?: number;
}

function Svg({ size = 12, children }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.2 14.4 13.4H1.6Z" />
      <path d="M8 6.4v3.2M8 11.6v.1" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
    </Svg>
  );
}

export function ContrastIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4v11.2A5.6 5.6 0 0 0 8 2.4Z" fill="currentColor" />
    </Svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="6.5" r="1.4" />
      <path d="M4.5 4.9v6.2M11.5 7.9c0 2.4-7 1.6-7 3.2" />
    </Svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
      <path d="M4.6 6.4 6.6 8l-2 1.6M8.4 10h3" />
    </Svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="4.5" r="1.4" />
      <path d="M4.5 4.9v6.2M11.5 5.9c0 3-7 2.6-7 5.2" />
    </Svg>
  );
}

export function CloudIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.6 12.4h7.2a2.8 2.8 0 0 0 .4-5.6 4 4 0 0 0-7.7 1A2.3 2.3 0 0 0 4.6 12.4Z" />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.4 2.4h5.2l6 6-5.2 5.2-6-6Z" />
      <circle cx="5.4" cy="5.4" r="0.9" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.6 5.6 8l4.4 4.4" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.6 10.4 8 6 12.4" />
    </Svg>
  );
}
