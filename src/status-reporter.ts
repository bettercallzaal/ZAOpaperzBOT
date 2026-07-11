import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";
import { config } from "./config.js";

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

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const SUPABASE_TIMEOUT_MS = 3000;

let client: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  client =
    config.supabaseUrl && config.supabaseServiceRoleKey
      ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
      : null;
  if (!client) {
    logger.warn("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set - status reporting disabled");
  }
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Supabase call timed out")), ms)),
  ]);
}

export function startHeartbeatLoop(
  getGuildCount: () => number,
  getFaqCacheAgeMinutes: () => number | null,
): void {
  const sendHeartbeat = async () => {
    const supabase = getClient();
    if (!supabase) return;
    try {
      const payload = buildHeartbeatPayload(getGuildCount(), getFaqCacheAgeMinutes());
      const { error } = await withTimeout(
        supabase.from("bot_heartbeats").upsert(payload, { onConflict: "bot" }).select() as unknown as Promise<{ error: null | { message: string } }>,
        SUPABASE_TIMEOUT_MS,
      );
      if (error) throw error;
    } catch (err) {
      logger.warn({ err }, "Heartbeat write failed");
    }
  };
  void sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

export function logCommandEvent(question: string, matched: boolean, score: number | null): void {
  const supabase = getClient();
  if (!supabase) return;
  const payload = buildCommandEventPayload(question, matched, score);
  void withTimeout(supabase.from("bot_events").insert(payload).select() as unknown as Promise<unknown>, SUPABASE_TIMEOUT_MS).catch((err) => {
    logger.warn({ err }, "Command event write failed");
  });
}
