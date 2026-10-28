"use client";

import { ErrorView } from "../_ui/error-view";

export default function RetailError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorView reset={reset} />;
}
