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
      .setName(Commands.Setup)
      .setDescription("Set the game mode for this channel.")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("The game mode to run in this channel.")
          .setRequired(true)
          .addChoice(GameMode.BBall, GameMode.BBall)
          .addChoice(GameMode.Highlander, GameMode.Highlander)
          .addChoice(GameMode.Sixes, GameMode.Sixes)
          .addChoice(GameMode.Ultiduo, GameMode.Ultiduo)
          .addChoice(GameMode.Test, GameMode.Test)
      ),
    new SlashCommandBuilder()
      .setName(Commands.Start)
      .setDescription("Start a new PUG."),
    new SlashCommandBuilder()
      .setName(Commands.Status)
      .setDescription("Get the status of current PUG."),
    new SlashCommandBuilder()
      .setName(Commands.Maps)
      .setDescription(
        "List all maps available for the game mode of the channel."
      ),
    new SlashCommandBuilder()
      .setName(Commands.Add)
      .setDescription("Add to the PUG."),
    new SlashCommandBuilder()
      .setName(Commands.Remove)
      .setDescription("Remove from the PUG."),
    new SlashCommandBuilder()
      .setName(Commands.Kick)
      .setDescription("Kick a player from the PUG.")
      .addUserOption((option) =>
        option
          .setName("user")
          .setRequired(true)
          .setDescription("The player to be kicked.")
      ),
    new SlashCommandBuilder()
      .setName(Commands.Ready)
      .setDescription("Ready up")
      .addNumberOption((option) =>
        option
          .setName("minutes")
          .setDescription("The number of minutes you want to be ready for.")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName(Commands.Stop)
      .setDescription("Stop the PUG."),
    new SlashCommandBuilder()
      .setName(Commands.Vacate)
      .setDescription(
        "Kick all players one of the PUG TF2 servers. You will be asked (buttons) which server to vacate."
      ),
    new SlashCommandBuilder()
      .setName(Commands.MapVote)
      .setDescription(
        "Vote for the map you want to play. You will be presented with button options."
      ),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "9" }).setToken(token);

  rest
    .put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
    .then(() => console.log("Successfully registered application commands."))
    .catch(console.error);
};

run();
