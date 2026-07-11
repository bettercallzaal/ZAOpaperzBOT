import { Client, GatewayIntentBits, Events, type Interaction } from "discord.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import * as zaoCommand from "./commands/zao.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  logger.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, "ZAO Paperz bot ready");
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "zao") {
      await zaoCommand.execute(interaction);
    } else if (interaction.isStringSelectMenu() && interaction.customId === "zao_faq_topic") {
      await zaoCommand.handleSelect(interaction);
    }
  } catch (err) {
    logger.error({ err }, "Interaction handler failed");
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: "Something went wrong. Try again in a moment.", ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.Error, (err) => logger.error({ err }, "Discord client error"));

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  client.destroy();
  process.exit(0);
});

client.login(config.discordBotToken);
