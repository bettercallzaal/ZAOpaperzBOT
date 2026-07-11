import { logger } from "./logger.js";

const BOT_NAME = "zaopaperz";
const MAX_MESSAGE_LENGTH = 200;

export interface HeartbeatPayload {
  bot: string;
  status: string;
  ts: string;
  meta: { guildCount: number; faqCacheAgeMinutes: number | null };
}

export interface CommandEventPayload {
  bot: string;
  kind: string;
  message: string;
  meta: { matched: boolean; score: number | null };
}

export function buildHeartbeatPayload(
  guildCount: number,
  faqCacheAgeMinutes: number | null,
): HeartbeatPayload {
  return {
    bot: BOT_NAME,
    status: "up",
    ts: new Date().toISOString(),
    meta: { guildCount, faqCacheAgeMinutes },
  };
}

export function buildCommandEventPayload(
  question: string,
  matched: boolean,
  score: number | null,
): CommandEventPayload {
  return {
    bot: BOT_NAME,
    kind: "command",
    message: question.length > MAX_MESSAGE_LENGTH ? question.slice(0, MAX_MESSAGE_LENGTH) : question,
    meta: { matched, score },
  };
}
