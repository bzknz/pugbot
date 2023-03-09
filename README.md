# Pugbot

A Discord TF2 pick-up game (PUG) bot that handles sixes, ultiduo, bball, fours, highlander an prolander and game modes. It has a ready-up check and a map voting phase. The winning map is set on the server via RCON. A server is selected from a pool of servers set in the `.env` file. The first server with no players connected will be used.

A game mode is set per Discord channel with the `/setup` slash command in the channel. Channel game modes are saved in `./data/channels/`. Data for each game is saved in `./data/games/`.

The bot expects the TF2 servers to be configured to set the game mode rules based on the map that has been selected. For example a per map `.cfg` file that runs something like `exec etf2l_6v6_5cp.cfg`. In other words, this bot only sets the map on the TF2 server and does no additional config via RCON.

## Config

## `.evn` file

Requires an `.env` file in the root of the repo with these variables:

```bash
# The Discord bot token from eg. https://discord.com/developers/applications/<application-id>/bot
DISCORD_BOT_TOKEN=<token>

# Id of the server (right-click on the server's icon)
DISCORD_GUILD_ID=<id>

# Id of the bot 'user' in the server (right-click on the bot user)
DISCORD_CLIENT_ID=<id>

# Comma separated TF2 servers (socket addresses)
TF2_SERVERS=111.111.111.111:27015,111.111.111.112:27015

# Rcon password set on each of these TF2 servers
RCON_PASSWORD=<password>
```

## Maps

Take a look in `./data/maps.json`

## Install dependencies

```bash
nvm install # From `.nvmrc` file
nvm use
npm install
```

## Register slash commands on the Discord server

```bash
npm run register
```

## Start the bot

```bash
npm run start
```
