import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Outgoing mail. Nothing here touches the network: development writes each message to a file
 * under .data/mail/ (git-ignored), tests collect messages in memory. A real transport is a later
 * task; until then production refuses to send rather than silently writing secrets to disk.
 */

export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Test mailer: keeps every message in `messages`. */
export class MemoryMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.messages.push({ ...message });
  }
}

/** Development mailer: one text file per message in `dir` (default <cwd>/.data/mail). */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string = path.join(process.cwd(), ".data", "mail")) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.txt`;
    const body = `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`;
    await writeFile(path.join(this.dir, name), body, { encoding: "utf8", flag: "wx" });
  }
}

class UnconfiguredMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error("No mail transport is configured for production");
  }
}

function defaultMailer(): Mailer {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return new MemoryMailer();
  if (process.env.NODE_ENV === "production") return new UnconfiguredMailer();
  return new FileMailer();
}

let current: Mailer | undefined;

export function getMailer(): Mailer {
  return (current ??= defaultMailer());
}

/** Replaces the mailer (tests); undefined restores the default on next use. */
export function setMailer(mailer: Mailer | undefined): void {
  current = mailer;
}
