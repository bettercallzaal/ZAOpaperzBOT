import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getFaq, findBestMatch } from "../faq.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const MATCH_THRESHOLD = 0.34;
const ACCENT_COLOR = 0xf5a623;

export const data = new SlashCommandBuilder()
  .setName("zao")
  .setDescription("Ask about The ZAO - what it is, how it works, how to join.")
  .addStringOption((opt) =>
    opt
      .setName("question")
      .setDescription("Your question - leave blank to see the topic list")
      .setRequired(false),
  );

function topicSelectRow(entries: { question: string }[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("zao_faq_topic")
    .setPlaceholder("Or pick a topic")
    .addOptions(
      entries.slice(0, 25).map((e, i) => ({
        label: e.question.length > 100 ? e.question.slice(0, 97) + "..." : e.question,
        value: String(i),
      })),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function answerEmbed(question: string, answer: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT_COLOR)
    .setTitle(question)
    .setDescription(answer)
    .setFooter({ text: "The ZAO Papers" })
    .setURL(config.faqUrl);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const question = interaction.options.getString("question");

  let faq;
  try {
    faq = await getFaq();
  } catch (err) {
    logger.error({ err }, "Failed to load FAQ for /zao command");
    await interaction.editReply(
      `Couldn't reach the source page right now (${config.faqUrl}). Try again shortly, or read it directly there.`,
    );
    return;
  }

  if (!question) {
    const embed = new EmbedBuilder()
      .setColor(ACCENT_COLOR)
      .setTitle("What is The ZAO?")
      .setDescription(faq.thesis)
      .addFields({
        name: "Ask a question",
        value: "`/zao question: <your question>` - or pick a topic below.",
      })
      .setURL(config.faqUrl)
      .setFooter({ text: "The ZAO Papers - full read at thezao.xyz/what-is-the-zao" });
    await interaction.editReply({ embeds: [embed], components: [topicSelectRow(faq.entries)] });
    return;
  }

  const match = findBestMatch(faq.entries, question);
  if (!match || match.score < MATCH_THRESHOLD) {
    const embed = new EmbedBuilder()
      .setColor(ACCENT_COLOR)
      .setTitle("Not sure I have that one")
      .setDescription(
        `${faq.thesis}\n\nThat didn't clearly match one of the papers' FAQ topics. Try rephrasing, or pick a topic below - or read the full page: ${config.faqUrl}`,
      )
      .setFooter({ text: "The ZAO Papers" });
    await interaction.editReply({ embeds: [embed], components: [topicSelectRow(faq.entries)] });
    return;
  }

  await interaction.editReply({ embeds: [answerEmbed(match.entry.question, match.entry.answer)] });
}

export async function handleSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const faq = await getFaq();
  const idx = Number(interaction.values[0]);
  const entry = faq.entries[idx];
  if (!entry) return;
  await interaction.editReply({
    embeds: [answerEmbed(entry.question, entry.answer)],
    components: [topicSelectRow(faq.entries)],
  });
}
