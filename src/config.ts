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
  supabaseUrl: process.env.SUPABASE_URL || undefined,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
};
