import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eligibility, explicitExternalRecipients, parseConfig, plainTextToHtml,
  renderThread, replyRecipients, type GmailMessage,
} from "../src/mail.js";

const config = parseConfig({
  account: "agent@example.com",
  domains: ["example.com"],
  senders: ["bek@unblocklabs.ai"],
  selfAddresses: ["alias@example.com"],
});
const now = Math.floor(Date.now() / 1000);

test("a sender-only config may omit domains", () => {
  assert.deepEqual(parseConfig({ account: "agent@example.com", senders: ["bek@unblocklabs.ai"] }).domains, []);
});

function message(from = "Bek <bek@example.com>", extra: Record<string, string> = {}, received = now): GmailMessage {
  const values = {
    From: from,
    To: "agent@example.com",
    "Authentication-Results": "mx.google.com; dmarc=pass header.from=example.com",
    ...extra,
  };
  return {
    id: "aa01", threadId: "bb01", internalDate: String(received * 1000), labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain", body: { data: Buffer.from("Message body").toString("base64url") },
      headers: Object.entries(values).map(([name, value]) => ({ name, value })),
    },
  };
}

test("sender authorization is exact and uses the first Google authentication header", () => {
  assert.equal(eligibility(message(), config, { activeSince: now - 60 }).accepted, true);
  for (const sender of ["bad@example.com.evil.com", "bad@sub.example.com", "agent@example.com", "one@example.com,two@example.com"]) {
    assert.equal(eligibility(message(sender), config, { activeSince: now - 60 }).accepted, false, sender);
  }
  for (const auth of ["", "evil.example; dmarc=pass header.from=example.com", "mx.google.com; dmarc=fail header.from=example.com", "mx.google.com; dmarc=pass header.from=example.com.evil.com"]) {
    assert.equal(eligibility(message(undefined, { "Authentication-Results": auth }), config, { activeSince: now - 60 }).accepted, false, auth);
  }
  const forged = message(undefined, { "Authentication-Results": "mx.google.com; dmarc=fail header.from=example.com" });
  forged.payload.headers?.push({ name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com" });
  assert.equal(eligibility(forged, config, { activeSince: now - 60 }).accepted, false);
});

test("old, automated, excluded, and newly authorized sender mail is rejected", () => {
  const cutoffs = { activeSince: now - 60, senderSince: { "bek@unblocklabs.ai": now - 10 } };
  assert.equal(eligibility(message(undefined, {}, now - 61), config, cutoffs).reason, "before-activation");
  assert.equal(eligibility(message(undefined, { "Auto-Submitted": "auto-replied" }), config, cutoffs).reason, "automatic-reply");
  assert.equal(eligibility(message(undefined, { "List-ID": "list" }), config, cutoffs).reason, "mailing-list");
  const sent = message(); sent.labelIds = ["SENT"];
  assert.equal(eligibility(sent, config, cutoffs).reason, "excluded-label");
  const explicit = message("bek@unblocklabs.ai", { "Authentication-Results": "mx.google.com; dmarc=pass header.from=unblocklabs.ai" }, now - 11);
  assert.equal(eligibility(explicit, config, cutoffs).reason, "before-activation");
  const bothRoutes = parseConfig({ account: "agent@example.com", domains: ["unblocklabs.ai"], senders: ["bek@unblocklabs.ai"] });
  assert.equal(eligibility(explicit, bothRoutes, {
    activeSince: now - 60,
    domainSince: { "unblocklabs.ai": now - 10 },
    senderSince: { "bek@unblocklabs.ai": now - 60 },
  }).accepted, true);
});

test("reply recipients use visible From, To, Cc only and explicit externals remain exact", () => {
  const mail = message(undefined, {
    To: 'agent@example.com, "Sarah, Team" <SARAH@example.com>, guest@external.test',
    Cc: 'sarah@example.com, alias@example.com, Charlie <charlie@example.com>, bek@unblocklabs.ai',
    "Reply-To": "attacker@example.com", Bcc: "hidden@example.com",
  });
  assert.deepEqual(replyRecipients(mail, config), {
    to: ["bek@example.com", "sarah@example.com"], cc: ["charlie@example.com", "bek@unblocklabs.ai"],
  });
  assert.deepEqual(replyRecipients(mail, config, true).to, ["bek@example.com", "sarah@example.com", "guest@external.test"]);
  assert.deepEqual(explicitExternalRecipients(["Customer <CUSTOMER@external.test>", "customer@external.test"], ["bek@example.com"]), ["customer@external.test"]);
  assert.throws(() => explicitExternalRecipients(["a@external.test,b@external.test"], []));
});

test("full thread renders chronologically and plain replies preserve lists", () => {
  const older = message(); older.id = "aa00"; older.internalDate = String((now - 60) * 1000);
  const newer = message(); newer.id = "aa02";
  const transcript = renderThread({ id: "bb01", messages: [newer, older] });
  assert.ok(transcript.indexOf("aa00") < transcript.indexOf("aa02"));
  assert.match(transcript, /Message body/);
  assert.match(plainTextToHtml("Intro <unsafe>\n\n- First\n- Second & final"), /<ul><li>First<\/li><li>Second &amp; final<\/li><\/ul>/);
});
