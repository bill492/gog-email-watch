import { attachmentNames, bodyText, sentDate, type GmailPart, type GmailThread } from "./mail.js";
import { hash } from "./policy.js";
import type { RuntimeSettings } from "./policy.js";
import type { DecisionBatch, JsonValue } from "openclaw/plugin-sdk/decisions";
import { get_encoding } from "tiktoken";

// Jev does not publish its tokenizer. This is an estimate, not a vendor count.
let tokenizer: ReturnType<typeof get_encoding> | undefined;
const tokens = (value: unknown) => (tokenizer ??= get_encoding("cl100k_base")).encode(JSON.stringify(value), [], []).length;

export function evidence(thread: GmailThread) {
  const missing = new Set<string>();
  function scan(part: GmailPart) {
    if (part.filename || part.body?.attachmentId) missing.add("unscanned attachment");
    if (!part.parts?.length && !part.filename && !part.body?.attachmentId && part.mimeType !== "text/plain" && part.mimeType !== "text/html") missing.add("unsupported MIME part");
    for (const child of part.parts ?? []) scan(child);
  }
  const messages = thread.messages.filter(message => !message.labelIds.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id));
  // Mailbox metadata is a snapshot, not new conversation content. Reading mail or
  // applying our own labels must not invalidate the assessment and repeat a wake.
  const fingerprint = hash({ format: 4, threadId: thread.id, messages: messages.map(({ id, internalDate, payload }) => ({ id, internalDate, payload })) });
  const sections = messages.map(message => {
    scan(message.payload);
    const body = bodyText(message.payload).trim();
    if (!body) missing.add("missing inline body");
    const headers = (message.payload.headers ?? []).filter(header => ["from", "to", "cc", "bcc", "reply-to", "subject"].includes(header.name.toLowerCase()));
    const names = attachmentNames(message.payload);
    const labels = message.labelIds.filter(id => id !== "IMPORTANT").map(id => thread.labelNames?.[id] ?? id);
    return [`Sent date: ${sentDate(message)}`, `Message ID: ${message.id}`, ...headers.map(header => `${header.name}: ${header.value}`),
      `Read status: ${message.labelIds.includes("UNREAD") ? "unread" : "read"}`,
      `Starred: ${message.labelIds.includes("STARRED")}`,
      `Gmail labels: ${JSON.stringify(labels)}`,
      ...(names.length ? [`Attachments (filenames only; contents not scanned): ${JSON.stringify(names)}`] : []), "", body].join("\n");
  });
  return {
    content: { format: 4, threadId: thread.id, text: sections.join("\n\n---\n\n") }, hash: fingerprint,
    complete: missing.size === 0, missing: [...missing], sections,
  };
}

/** Keep the newest messages and the beginning of an oversized newest message. */
export function fitEvidence(source: ReturnType<typeof evidence>, context: Record<string, JsonValue>,
  questions: DecisionBatch["questions"], limits: Pick<RuntimeSettings, "maxInputTokens" | "maxRequestTokens">) {
  const budget = Math.min(limits.maxInputTokens - Math.max(...Object.values(questions).map(tokens)),
    limits.maxRequestTokens - tokens(questions));
  let text = source.content.text;
  const state = () => ({ ...context, evidence: { ...source.content, text, ...(trimmed ? { truncated: true } : {}) } });
  let trimmed = false;
  if (tokens(state()) > budget) {
    trimmed = true;
    // Locate the longest recent suffix without re-tokenizing every suffix.
    let first = 0, last = source.sections.length - 1;
    while (first < last) {
      const mid = Math.floor((first + last) / 2);
      text = source.sections.slice(mid).join("\n\n---\n\n");
      if (tokens(state()) <= budget) last = mid; else first = mid + 1;
    }
    text = source.sections.slice(first).join("\n\n---\n\n");
    if (tokens(state()) > budget) {
      const latest = Array.from(source.sections.at(-1) ?? "");
      let low = 0, high = latest.length;
      text = "";
      if (tokens(state()) > budget) throw new Error("Jev token budget cannot fit policy and metadata; shorten instructions or increase token settings");
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        text = latest.slice(0, mid).join("");
        if (tokens(state()) <= budget) low = mid; else high = mid - 1;
      }
      text = latest.slice(0, low).join("");
    }
  }
  return { state: state(), coverage: { complete: source.complete && !trimmed,
    missing: [...source.missing, ...(trimmed ? ["conversation trimmed to token budget"] : [])] } };
}
