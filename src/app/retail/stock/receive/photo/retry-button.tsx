"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** "Try again" for a page whose server read failed: refreshes it in place (no full reload). */
export function RetryButton({ label, busyLabel }: { label: string; busyLabel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-primary"
      aria-busy={pending || undefined}
      onClick={() => {
        if (pending) return;
        start(() => router.refresh());
      }}
      data-testid="intake-status-retry"
    >
      {pending ? busyLabel : label}
    </button>
  );
}
