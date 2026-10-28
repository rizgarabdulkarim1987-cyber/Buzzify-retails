"use client";

import { ErrorView } from "../_ui/error-view";

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorView reset={reset} />;
}
