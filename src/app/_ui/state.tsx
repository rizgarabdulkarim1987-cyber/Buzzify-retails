import type { ReactNode } from "react";
import { AlertIcon, CheckIcon, InboxIcon, LockIcon } from "./icons";

const ICONS = { empty: InboxIcon, locked: LockIcon, alert: AlertIcon } as const;

/** A full empty / no-permission / unavailable state: icon, title, explanation, optional action. */
export function StateBlock(props: {
  kind: keyof typeof ICONS;
  title: string;
  body: string;
  action?: ReactNode;
  testId?: string;
}) {
  const Icon = ICONS[props.kind];
  return (
    <section className="state" data-tone={props.kind === "empty" ? undefined : "danger"} data-testid={props.testId}>
      <div className="state-icon">
        <Icon />
      </div>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {props.action}
    </section>
  );
}

/** An inline message above content: an error (role=alert) or a confirmation (role=status). */
export function Notice({ tone, children }: { tone: "danger" | "success"; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {tone === "danger" ? <AlertIcon /> : <CheckIcon />}
      <span>{children}</span>
    </div>
  );
}
