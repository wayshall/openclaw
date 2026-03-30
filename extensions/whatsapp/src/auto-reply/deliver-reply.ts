import type { MiscMessageGenerationOptions } from "@whiskeysockets/baileys";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOutboundMediaUrls,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import { markdownToWhatsApp } from "openclaw/plugin-sdk/text-runtime";
import { sleep } from "openclaw/plugin-sdk/text-runtime";
import { loadWebMedia } from "../media.js";
import { buildQuotedMessageKey, buildQuotedMessageOptions } from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappOutboundLog } from "./loggers.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

const REASONING_PREFIX = "reasoning:";

function shouldSuppressReasoningReply(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return true;
  }
  const text = payload.text;
  if (typeof text !== "string") {
    return false;
  }
  return text.trimStart().toLowerCase().startsWith(REASONING_PREFIX);
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  replyToMode?: "off" | "first" | "all";
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}) {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const replyStarted = Date.now();
  if (shouldSuppressReasoningReply(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
    return;
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(replyResult.text || "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = resolveOutboundMediaUrls(replyResult);

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string, maxAttempts = 3) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatError(err);
        const isLast = attempt === maxAttempts;
        const shouldRetry = /closed|reset|timed\s*out|disconnect/i.test(errText);
        if (!shouldRetry || isLast) {
          throw err;
        }
        const backoffMs = 500 * attempt;
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${errText}`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  };

  // Build Baileys quoted options from the payload-level replyToId set by the
  // shared reply threading pipeline. The pipeline reads replyToMode from the
  // WhatsApp threading adapter and controls which payloads get replyToId.
  // Delivery still needs the mode so "first" only quotes the first successful
  // chunk within a multi-part payload.
  const quotedOptions: MiscMessageGenerationOptions | undefined = buildQuotedMessageOptions(
    buildQuotedMessageKey({
      replyToId: replyResult.replyToId,
      remoteJid: msg.chatId,
      fromMe: msg.fromMe,
      participant: msg.senderJid,
      body: msg.body,
    }),
  );
  let quoteConsumed = false;
  const getQuotedOptions = () => {
    if (!quotedOptions) {
      return undefined;
    }
    if (params.replyToMode === "first" && quoteConsumed) {
      return undefined;
    }
    return quotedOptions;
  };
  const markQuoteSent = (quote: MiscMessageGenerationOptions | undefined) => {
    if (!quote || params.replyToMode !== "first") {
      return;
    }
    quoteConsumed = true;
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuotedOptions();
      await sendWithRetry(() => msg.reply(chunk, quote), "text");
      markQuoteSent(quote);
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: elide(replyResult.text, 240),
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    return;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await loadWebMedia(mediaUrl, {
        maxBytes: maxMediaBytes,
        localRoots: params.mediaLocalRoots,
      });
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      if (media.kind === "image") {
        const quote = getQuotedOptions();
        await sendWithRetry(
          () => msg.sendMedia({ image: media.buffer, caption, mimetype: media.contentType }, quote),
          "media:image",
        );
        markQuoteSent(quote);
      } else if (media.kind === "audio") {
        const quote = getQuotedOptions();
        await sendWithRetry(
          () =>
            msg.sendMedia(
              { audio: media.buffer, ptt: true, mimetype: media.contentType, caption },
              quote,
            ),
          "media:audio",
        );
        markQuoteSent(quote);
      } else if (media.kind === "video") {
        const quote = getQuotedOptions();
        await sendWithRetry(
          () => msg.sendMedia({ video: media.buffer, caption, mimetype: media.contentType }, quote),
          "media:video",
        );
        markQuoteSent(quote);
      } else {
        const fileName = media.fileName ?? mediaUrl.split("/").pop() ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        const quote = getQuotedOptions();
        await sendWithRetry(
          () => msg.sendMedia({ document: media.buffer, fileName, caption, mimetype }, quote),
          "media:document",
        );
        markQuoteSent(quote);
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(error)}`);
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      if (!isFirst) {
        return;
      }
      const warning =
        error instanceof Error ? `⚠️ Media failed: ${error.message}` : "⚠️ Media failed.";
      const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
      const quote = getQuotedOptions();
      await msg.reply(fallbackText, quote);
      markQuoteSent(quote);
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    const quote = getQuotedOptions();
    await msg.reply(chunk, quote);
    markQuoteSent(quote);
  }
}
