import { REST, Routes } from "discord.js";
import { config } from "../src/config.js";
import { data as zaoCommand } from "../src/commands/zao.js";

const commands = [zaoCommand.toJSON()];

const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

async function main() {
  if (config.discordTestGuildId) {
    // Guild commands propagate instantly - use for local dev only.
    await rest.put(
      Routes.applicationGuildCommands(config.discordAppId, config.discordTestGuildId),
      { body: commands },
    );
    console.log(`Registered ${commands.length} command(s) to test guild ${config.discordTestGuildId}`);
  } else {
    // Global commands can take up to ~1hr to propagate to all servers.
    await rest.put(Routes.applicationCommands(config.discordAppId), { body: commands });
    console.log(`Registered ${commands.length} command(s) globally (may take up to 1hr to appear everywhere)`);
  }
}

main().catch((err) => {
  console.error("Command registration failed:", err);
  process.exit(1);
});
