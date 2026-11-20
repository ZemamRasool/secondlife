// Email notifications ("messaging by email", SPEC.md Milestone 3).
// Buyers and sellers never see each other's email address: messages go through the site,
// and each one is emailed to the other person with a link back to the conversation.
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

/** Development: print emails to the console instead of sending. */
export function createConsoleMailer(log: (s: string) => void = console.log): Mailer {
  return async (mail) => log(`\n✉  To: ${mail.to}\n   Subject: ${mail.subject}\n   ${mail.text.replace(/\n/g, "\n   ")}\n`);
}

/** Production: send through Postmark's API. */
export function createPostmarkMailer(token: string, from: string): Mailer {
  return async (mail) => {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": token },
      body: JSON.stringify({ From: from, To: mail.to, Subject: mail.subject, TextBody: mail.text, MessageStream: "outbound" }),
    });
    if (!res.ok) throw new Error(`Postmark error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** Never let a failed email break the user's action; log it instead. */
export function safeMailer(inner: Mailer): Mailer {
  return async (mail) => {
    try {
      await inner(mail);
    } catch (err) {
      console.error("email failed", err instanceof Error ? err.message : err);
    }
  };
}
