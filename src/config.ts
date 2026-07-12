import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  discordBotToken: required("DISCORD_BOT_TOKEN"),
  discordAppId: required("DISCORD_APP_ID"),
  discordTestGuildId: process.env.DISCORD_TEST_GUILD_ID || undefined,
  faqUrl: process.env.ZAO_FAQ_URL || "https://www.thezao.xyz/what-is-the-zao",
  faqRefreshMinutes: Number(process.env.FAQ_REFRESH_MINUTES || "360"),
  logLevel: process.env.LOG_LEVEL || "info",
  // Cowork Supabase project (etwvzrmlxeobinrlytza) - bot_heartbeats/bot_events
  // for the status dashboard.
  supabaseUrl: process.env.SUPABASE_URL || undefined,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
  // Zuke Supabase project (yhpszfepoerqgnewukkh) - paper_sections/paper_edits
  // for the papers RAG reindex. Deliberately separate env vars from the pair
  // above - these are two different Supabase projects and must never share
  // one URL/key (see docs/superpowers/specs/2026-07-11-papers-rag-foundation-design.md).
  ragSupabaseUrl: process.env.RAG_SUPABASE_URL || undefined,
  ragSupabaseServiceRoleKey: process.env.RAG_SUPABASE_SERVICE_ROLE_KEY || undefined,
  openaiApiKey: process.env.OPENAI_API_KEY || undefined,
};
