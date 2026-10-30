import type { ReactNode, SVGProps } from "react";

/* One icon set: 24px grid, 1.75 stroke, round caps. Decorative by default (aria-hidden). */

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const StoreIcon = () => (
  <Icon>
    <path d="M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9" />
    <path d="M3 6.5 4.6 4h14.8L21 6.5V8a3 3 0 0 1-5.5 1.6A3 3 0 0 1 12 11a3 3 0 0 1-3.5-1.4A3 3 0 0 1 3 8z" />
    <path d="M9.5 20v-5h5v5" />
  </Icon>
);

export const BranchIcon = () => (
  <Icon>
    <path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.25" />
  </Icon>
);

export const TerminalIcon = () => (
  <Icon>
    <rect x="3.5" y="4" width="17" height="11" rx="1.5" />
    <path d="M8 19.5h8M12 15v4.5" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
);

export const SwitchIcon = () => (
  <Icon>
    <path d="M7 4 4 7l3 3" />
    <path d="M4 7h12a4 4 0 0 1 4 4" />
    <path d="m17 20 3-3-3-3" />
    <path d="M20 17H8a4 4 0 0 1-4-4" />
  </Icon>
);

export const SignOutIcon = () => (
  <Icon>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 8 6 12l4 4" />
    <path d="M6 12h10" />
  </Icon>
);

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.75v5M12 16.25v.01" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.25 2.5 2.5 4.5-5" />
  </Icon>
);

export const InboxIcon = () => (
  <Icon>
    <path d="M4 13.5 6.2 5.6A1.5 1.5 0 0 1 7.6 4.5h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13.5" />
    <path d="M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5h-4.5l-1 2h-5l-1-2z" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

export const PackageIcon = () => (
  <Icon>
    <path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z" />
    <path d="m4 7.2 8 4.3 8-4.3" />
    <path d="M12 11.5V21" />
  </Icon>
);

export const StockIcon = () => (
  <Icon>
    <path d="M4 20h16" />
    <path d="M5 20v-6h6v6" />
    <path d="M13 20V9h6v11" />
    <path d="M8 14V8h5" />
  </Icon>
);
