import { bodyText, sentDate, type GmailPart, type GmailThread } from "./mail.js";
import { hash } from "./policy.js";

export function evidence(thread: GmailThread) {
  const missing = new Set<string>();
  function scan(part: GmailPart) {
    if (part.filename || part.body?.attachmentId) missing.add("unscanned attachment");
    if (!part.parts?.length && !part.filename && !part.body?.attachmentId && part.mimeType !== "text/plain" && part.mimeType !== "text/html") missing.add("unsupported MIME part");
    for (const child of part.parts ?? []) scan(child);
  }
  const messages = thread.messages.filter(message => !message.labelIds.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id));
  // Our own labels must not invalidate the conversation's assessment.
  const fingerprint = hash({ format: 3, threadId: thread.id, messages: messages.map(({ id, internalDate, payload }) => ({ id, internalDate, payload })) });
  const sections = messages.map(message => {
    scan(message.payload);
    const body = bodyText(message.payload).trim();
    if (!body) missing.add("missing inline body");
    const headers = (message.payload.headers ?? []).filter(header => ["from", "to", "cc", "subject"].includes(header.name.toLowerCase()));
    return [`Sent date: ${sentDate(message)}`, `Message ID: ${message.id}`, ...headers.map(header => `${header.name}: ${header.value}`), "", body].join("\n");
  });
  return {
    content: { format: 3, threadId: thread.id, text: sections.join("\n\n---\n\n") }, hash: fingerprint,
    complete: missing.size === 0, missing: [...missing],
  };
}
