import { bodyText, type GmailPart, type GmailThread } from "./mail.js";
import { hash } from "./policy.js";

export function evidence(thread: GmailThread) {
  const missing = new Set<string>();
  function scan(part: GmailPart, attachments: string[], inline: Array<{ type: string; text: string }>) {
    if (part.filename || part.body?.attachmentId) { missing.add("unscanned attachment"); attachments.push(part.filename || "unnamed part"); }
    // Include raw HTML, not only rendered prose: link targets and hidden instructions
    // must be screened too. Never fetch links or execute attachments.
    if ((part.mimeType === "text/html" || part.mimeType === "text/plain") && part.body?.data)
      inline.push({ type: part.mimeType, text: Buffer.from(part.body.data, "base64url").toString("utf8") });
    if (!part.parts?.length && !part.filename && !part.body?.attachmentId && part.mimeType !== "text/plain" && part.mimeType !== "text/html") missing.add("unsupported MIME part");
    for (const child of part.parts ?? []) scan(child, attachments, inline);
  }
  const messages = [...thread.messages].sort((a, b) => Number(a.internalDate) - Number(b.internalDate)).map(message => {
    const attachments: string[] = [], inline: Array<{ type: string; text: string }> = [];
    scan(message.payload, attachments, inline);
    const body = bodyText(message.payload);
    if (!body.trim()) missing.add("missing inline body");
    return { id: message.id, received: message.internalDate, headers: message.payload.headers ?? [], inline, attachments };
  });
  const content = { format: 1, threadId: thread.id, messages };
  if (Buffer.byteLength(JSON.stringify(content)) > 200_000) missing.add("thread exceeds assessment limit");
  return { content, hash: hash(content), complete: missing.size === 0, missing: [...missing] };
}
