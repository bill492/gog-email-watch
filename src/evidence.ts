import { bodyText, type GmailPart, type GmailThread } from "./mail.js";
import { defaultSettings, hash, type RuntimeSettings } from "./policy.js";

// Bound JSON-encoded UTF-8 bytes (including escaping), without splitting codepoints.
// The default leaves headroom for policy/questions; this is not a tokenizer.
function prefix(text: string, bytes: number): string {
  if (Buffer.byteLength(JSON.stringify(text)) - 2 <= bytes) return text;
  let length = 0;
  for (const char of text) {
    bytes -= Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes < 0) break;
    length += char.length;
  }
  return text.slice(0, length);
}

export function evidence(thread: GmailThread, targetId?: string, settings: RuntimeSettings["evidence"] = defaultSettings.evidence) {
  const missing = new Set<string>();
  function scan(part: GmailPart) {
    if (part.filename || part.body?.attachmentId) missing.add("unscanned attachment");
    if (!part.parts?.length && !part.filename && !part.body?.attachmentId && part.mimeType !== "text/plain" && part.mimeType !== "text/html") missing.add("unsupported MIME part");
    for (const child of part.parts ?? []) scan(child);
  }
  const messages = [...thread.messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate) || a.id.localeCompare(b.id));
  // Fingerprint the full source, not the excerpt. Our own labels must not invalidate it.
  const fingerprint = hash({ format: 2, threadId: thread.id, messages: messages.map(({ id, internalDate, payload }) => ({ id, internalDate, payload })) });
  const ordered = targetId && settings.context === "message" ? messages.filter(message => message.id === targetId)
    : [...messages.filter(message => message.id === targetId), ...messages.filter(message => message.id !== targetId)];
  const text = ordered.map(message => {
    scan(message.payload);
    const body = bodyText(message.payload).trim();
    if (!body) missing.add("missing inline body");
    const headers = (message.payload.headers ?? []).filter(header => ["from", "to", "cc", "subject", "date"].includes(header.name.toLowerCase()));
    return [`Message ID: ${message.id}`, ...headers.map(header => `${header.name}: ${header.value}`), "", body].join("\n");
  }).join("\n\n---\n\n");
  const content = { format: 2, threadId: thread.id, text: "", truncated: false };
  const available = settings.maxBytes - Buffer.byteLength(JSON.stringify(content));
  if (available < 0) throw new Error("evidence.maxBytes is too small for the evidence envelope");
  content.text = prefix(text, available);
  content.truncated = content.text.length < text.length;
  return {
    content, hash: fingerprint,
    complete: missing.size === 0 && !content.truncated, truncated: content.truncated, missing: [...missing],
  };
}
