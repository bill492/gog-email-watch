import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { readStringArrayParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { parseConfig } from "./mail.js";
import { createMailWorkflow } from "./workflow.js";

export default definePluginEntry({
  id: "gog-email-watch",
  name: "Gog Email Watch",
  description: "Watch Gmail through gog and handle approved mail in persistent agent threads.",
  configSchema: { parse: parseConfig },
  register(api) {
    let workflow: ReturnType<typeof createMailWorkflow> | undefined;
    const activeWorkflow = () => {
      if (!workflow) throw new Error("Email watcher is not running; check its Gateway service status.");
      return workflow;
    };

    api.registerService({
      id: "gog-email-watch",
      async start(ctx) {
        const config = parseConfig(api.pluginConfig);
        const mailboxKey = createHash("sha256").update(config.account).digest("hex").slice(0, 16);
        workflow = createMailWorkflow({
          config,
          stateDir: join(ctx.stateDir, "gog-email-watch", mailboxKey),
          subagent: api.runtime.subagent,
          logger: ctx.logger,
        });
        await workflow.start();
      },
      async stop() {
        await workflow?.stop();
        workflow = undefined;
      },
    });

    api.registerTool((ctx): AnyAgentTool[] => {
      if (!ctx.sessionKey) return [];
      const sessionKey = ctx.sessionKey;
      return [
        {
          name: "gog_email_reply",
          label: "Reply to watched email",
          description: "Reply to an active email job in its original Gmail thread. Normal replies include approved To/Cc recipients. Use externalScheduling only for scheduling with visible external participants; externalTo only for recipients explicitly requested by an approved sender.",
          parameters: Type.Object({
            jobId: Type.String(),
            body: Type.String({ description: "Email-ready plain text. The account's gog signature is appended." }),
            externalScheduling: Type.Optional(Type.Boolean()),
            replyTargetMessageId: Type.Optional(Type.String({ description: "Earlier message in the same thread; scheduling only." })),
            externalTo: Type.Optional(Type.Array(Type.String())),
          }),
          async execute(_id: string, params: Record<string, unknown>) {
            return jsonResult(await activeWorkflow().reply({
              jobId: readStringParam(params, "jobId", { required: true }),
              body: readStringParam(params, "body", { required: true }),
              sessionKey,
              externalScheduling: params.externalScheduling === true,
              replyTargetMessageId: readStringParam(params, "replyTargetMessageId"),
              externalTo: readStringArrayParam(params, "externalTo"),
            }));
          },
        },
        {
          name: "gog_email_skip",
          label: "Skip watched email",
          description: "Finish an active email job when no reply or action is needed, with a brief reason.",
          parameters: Type.Object({ jobId: Type.String(), reason: Type.String() }),
          async execute(_id: string, params: Record<string, unknown>) {
            return jsonResult(activeWorkflow().skip({
              jobId: readStringParam(params, "jobId", { required: true }),
              reason: readStringParam(params, "reason", { required: true }),
              sessionKey,
            }));
          },
        },
      ];
    }, { names: ["gog_email_reply", "gog_email_skip"] });

    api.registerCommand({
      name: "email-watch-status",
      description: "Show Gmail watcher polling, queue and job status.",
      handler: () => ({ text: JSON.stringify(workflow?.status() ?? { running: false }, null, 2) }),
    });
  },
});
