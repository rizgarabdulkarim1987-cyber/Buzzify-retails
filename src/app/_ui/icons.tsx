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

export const BarcodeIcon = () => (
  <Icon>
    <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
    <path d="M8 8v8M11 8v8M14 8v8M16.5 8v8" />
  </Icon>
);

export const CartIcon = () => (
  <Icon>
    <path d="M3.5 4.5h2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.3h8.1a1.5 1.5 0 0 0 1.5-1.2L20 8H6.4" />
    <circle cx="9.5" cy="19.5" r="1.25" />
    <circle cx="17" cy="19.5" r="1.25" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const MinusIcon = () => (
  <Icon>
    <path d="M5 12h14" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4.5 7h15M9.5 7V4.5h5V7" />
    <path d="M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12" />
  </Icon>
);

export const CashIcon = () => (
  <Icon>
    <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M6.5 9.5v.01M17.5 14.5v.01" />
  </Icon>
);

export const CardIcon = () => (
  <Icon>
    <rect x="3" y="5.5" width="18" height="13" rx="1.5" />
    <path d="M3 9.5h18M7 15h3" />
  </Icon>
);

export const PrintIcon = () => (
  <Icon>
    <path d="M7 8.5V4h10v4.5" />
    <rect x="4" y="8.5" width="16" height="7.5" rx="1.5" />
    <path d="M7 13.5h10V20H7z" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10 9v6M14 9v6" />
  </Icon>
);

export const SparkIcon = () => (
  <Icon>
    <path d="M12 3.5 13.8 9a1 1 0 0 0 .7.7l5.5 1.8-5.5 1.8a1 1 0 0 0-.7.7L12 19.5 10.2 14a1 1 0 0 0-.7-.7L4 11.5l5.5-1.8a1 1 0 0 0 .7-.7z" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

/** Backspace: points to the start of the line, so it is mirrored in RTL by the .icon-flip class. */
export const BackspaceIcon = () => (
  <Icon className="icon icon-flip">
    <path d="M9 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" />
    <path d="m12 9 5 6M17 9l-5 6" />
  </Icon>
);

export const DrawerIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M3 12h18M10 15.5h4" />
  </Icon>
);

export const GridIcon = () => (
  <Icon>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
  </Icon>
);

export const EyeIcon = () => (
  <Icon>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.75" />
  </Icon>
);

export const EyeOffIcon = () => (
  <Icon>
    <path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4" />
    <path d="M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.6-1.2" />
    <path d="M9.9 9.9a2.75 2.75 0 0 0 3.9 3.9" />
    <path d="M3 3l18 18" />
  </Icon>
);
