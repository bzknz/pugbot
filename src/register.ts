import { SlashCommandBuilder } from "@discordjs/builders";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import dotenv from "dotenv";
import { Commands, GameMode } from "./core";

dotenv.config();

const run = async () => {
  const token = process.env.DISCORD_BOT_TOKEN as string;
  const guildId = process.env.DISCORD_GUILD_ID as string;
  const clientId = process.env.DISCORD_CLIENT_ID as string;

  const commands = [
    new SlashCommandBuilder()
      .setName(Commands.Ping)
      .setDescription("Replies with pong!"),
    new SlashCommandBuilder()
      .setName(Commands.Setup)
      .setDescription("Set's up the game mode of the PUG")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("The game mode to run in this channel")
          .setRequired(true)
          .addChoice(GameMode.BBall, GameMode.BBall)
          .addChoice(GameMode.Highlander, GameMode.Highlander)
          .addChoice(GameMode.Sixes, GameMode.Sixes)
          .addChoice(GameMode.Ultiduo, GameMode.Ultiduo)
          .addChoice(GameMode.Test, GameMode.Test)
      ),
    new SlashCommandBuilder()
      .setName(Commands.Start)
      .setDescription("Starts a new PUG"),
    new SlashCommandBuilder()
      .setName(Commands.Add)
      .setDescription("Adds to the PUG"),
    new SlashCommandBuilder()
      .setName(Commands.Remove)
      .setDescription("Removes from the PUG"),
    new SlashCommandBuilder()
      .setName(Commands.Ready)
      .setDescription("Readies up"),
    new SlashCommandBuilder()
      .setName(Commands.Stop)
      .setDescription("Stops the PUG"),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "9" }).setToken(token);

  rest
    .put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
    .then(() => console.log("Successfully registered application commands."))
    .catch(console.error);
};

run();
