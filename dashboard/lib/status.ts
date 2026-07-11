import type { SupabaseClient } from "@supabase/supabase-js";

const BOT_NAME = "zaopaperz";
const STALE_THRESHOLD_MINUTES = 10;

export interface Heartbeat {
  bot: string;
  status: string;
  ts: string;
  meta: Record<string, unknown> | null;
  updated_at: string;
}

export interface BotEvent {
  id: number;
  bot: string;
  kind: string;
  message: string;
  meta: Record<string, unknown> | null;
  ts: string;
}

export interface DashboardStatus {
  online: boolean;
  lastSeen: string | null;
  guildCount: number | null;
  faqCacheAgeMinutes: number | null;
}

export interface DashboardData {
  status: DashboardStatus;
  events: BotEvent[];
}

export function deriveStatus(heartbeat: Heartbeat | null, nowMs: number): DashboardStatus {
  if (!heartbeat) {
    return { online: false, lastSeen: null, guildCount: null, faqCacheAgeMinutes: null };
  }
  const ageMinutes = (nowMs - new Date(heartbeat.ts).getTime()) / 60000;
  const meta = heartbeat.meta ?? {};
  const guildCount = typeof meta.guildCount === "number" ? meta.guildCount : null;
  const faqCacheAgeMinutes = typeof meta.faqCacheAgeMinutes === "number" ? meta.faqCacheAgeMinutes : null;
  return {
    online: ageMinutes <= STALE_THRESHOLD_MINUTES,
    lastSeen: heartbeat.ts,
    guildCount,
    faqCacheAgeMinutes,
  };
}

export async function fetchLatestHeartbeat(client: SupabaseClient): Promise<Heartbeat | null> {
  const { data, error } = await client
    .from("bot_heartbeats")
    .select("bot, status, ts, meta, updated_at")
    .eq("bot", BOT_NAME)
    .maybeSingle();
  if (error) throw error;
  return data as Heartbeat | null;
}

export async function fetchRecentEvents(client: SupabaseClient): Promise<BotEvent[]> {
  const { data, error } = await client
    .from("bot_events")
    .select("id, bot, kind, message, meta, ts")
    .eq("bot", BOT_NAME)
    .order("ts", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as BotEvent[];
}

interface Fetchers {
  fetchLatestHeartbeat: (client: SupabaseClient) => Promise<Heartbeat | null>;
  fetchRecentEvents: (client: SupabaseClient) => Promise<BotEvent[]>;
}

const defaultFetchers: Fetchers = { fetchLatestHeartbeat, fetchRecentEvents };

export async function getDashboardData(
  client: SupabaseClient | null,
  fetchers: Fetchers = defaultFetchers,
  nowMs: number = Date.now(),
): Promise<DashboardData> {
  if (!client) {
    return { status: deriveStatus(null, nowMs), events: [] };
  }
  try {
    const [heartbeat, events] = await Promise.all([
      fetchers.fetchLatestHeartbeat(client),
      fetchers.fetchRecentEvents(client),
    ]);
    return { status: deriveStatus(heartbeat, nowMs), events };
  } catch {
    return { status: deriveStatus(null, nowMs), events: [] };
  }
}
