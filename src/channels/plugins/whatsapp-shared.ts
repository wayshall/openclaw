import {
  chunkByParagraph,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOutboundSendDep } from "../../infra/outbound/send-deps.js";
import {
  attachChannelToResults,
  createAttachedChannelResultAdapter,
} from "../../plugin-sdk/channel-send-result.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { escapeRegExp, toWhatsappJid } from "../../utils.js";
import type { ChannelOutboundAdapter } from "./types.js";

export const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

export function resolveWhatsAppGroupIntroHint(): string {
  return WHATSAPP_GROUP_INTRO_HINT;
}

export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (!selfE164) {
    return [];
  }
  const escaped = escapeRegExp(selfE164);
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendMessage = PluginRuntimeChannel["whatsapp"]["sendMessageWhatsApp"];
type WhatsAppSendPoll = PluginRuntimeChannel["whatsapp"]["sendPollWhatsApp"];

function resolveQuotedMessageKey(replyToId: string | null | undefined, to: string) {
  const quotedId = replyToId?.trim();
  if (!quotedId) {
    return undefined;
  }
  return {
    id: quotedId,
    remoteJid: toWhatsappJid(to),
    fromMe: false,
  };
}

type CreateWhatsAppOutboundBaseParams = {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  resolveReplyToMode?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => "off" | "first" | "all";
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
};

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  resolveReplyToMode,
  normalizeText = (text) => text ?? "",
  skipEmptyText = false,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendFormattedText"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  const sendTextRaw = async ({
    cfg,
    to,
    text,
    accountId,
    deps,
    gifPlayback,
    replyToId,
  }: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => {
    const normalizedText = normalizeText(text);
    if (skipEmptyText && !normalizedText) {
      return { messageId: "" };
    }
    const send =
      resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
    return await send(to, normalizedText, {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
      gifPlayback,
      quotedMessageKey: resolveQuotedMessageKey(replyToId, to),
    });
  };

  const sendMediaRaw = async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    gifPlayback,
    replyToId,
  }: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0]) => {
    const send =
      resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
    return await send(to, normalizeText(text), {
      verbose: false,
      cfg,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
      quotedMessageKey: resolveQuotedMessageKey(replyToId, to),
    });
  };

  return {
    deliveryMode: "gateway",
    chunker,
    chunkerMode: "text",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget,
    sendFormattedText: async ({ cfg, to, text, accountId, deps, gifPlayback, replyToId }) => {
      const limit = resolveTextChunkLimit(cfg, "whatsapp", accountId ?? undefined, {
        fallbackLimit: 4000,
      });
      if (limit === undefined) {
        return attachChannelToResults("whatsapp", [
          await sendTextRaw({ cfg, to, text, accountId, deps, gifPlayback, replyToId }),
        ]);
      }

      const replyToMode = resolveReplyToMode?.({ cfg, accountId }) ?? "off";
      let nextReplyToId = replyToId;
      const results: Array<Awaited<ReturnType<typeof sendTextRaw>>> = [];
      const sendChunk = async (chunk: string) => {
        const result = await sendTextRaw({
          cfg,
          to,
          text: chunk,
          accountId,
          deps,
          gifPlayback,
          replyToId: nextReplyToId,
        });
        results.push(result);
        if (nextReplyToId && replyToMode === "first") {
          nextReplyToId = undefined;
        }
      };

      if (resolveChunkMode(cfg, "whatsapp", accountId ?? undefined) === "newline") {
        const blocks = chunkByParagraph(text, limit);
        const blockChunks = blocks.length > 0 ? blocks : text ? [text] : [];
        for (const block of blockChunks) {
          const chunks = chunker(block, limit);
          const sendableChunks = chunks.length > 0 ? chunks : block ? [block] : [];
          for (const chunk of sendableChunks) {
            await sendChunk(chunk);
          }
        }
        return attachChannelToResults("whatsapp", results);
      }

      const chunks = chunker(text, limit);
      const sendableChunks = chunks.length > 0 ? chunks : text ? [text] : [];
      for (const chunk of sendableChunks) {
        await sendChunk(chunk);
      }
      return attachChannelToResults("whatsapp", results);
    },
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
      sendText: sendTextRaw,
      sendMedia: sendMediaRaw,
      sendPoll: async ({ cfg, to, poll, accountId }) =>
        await sendPollWhatsApp(to, poll, {
          verbose: shouldLogVerbose(),
          accountId: accountId ?? undefined,
          cfg,
        }),
    }),
  };
}
