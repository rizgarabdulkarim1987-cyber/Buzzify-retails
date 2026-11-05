import type { ReactNode, SVGProps } from "react";

/* The few shop-section icons the app's icon set lacks, on the same 24px grid and stroke. */

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export const ExpensesIcon = () => (
  <Icon>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9.5 8h5M9.5 12h5" />
  </Icon>
);

export const SuppliersIcon = () => (
  <Icon>
    <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" />
    <circle cx="7" cy="17.5" r="1.75" />
    <circle cx="17" cy="17.5" r="1.75" />
  </Icon>
);

export const ReportsIcon = () => (
  <Icon>
    <path d="M4 20V4M4 20h16" />
    <path d="M8 16v-5M12 16V8M16 16v-3" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Icon>
);

export const DotsIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1.25" />
    <circle cx="12" cy="12" r="1.25" />
    <circle cx="19" cy="12" r="1.25" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon className="icon icon-flip">
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);
