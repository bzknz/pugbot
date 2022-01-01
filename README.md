# Pugbot

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
RCON_PASSWORD=<token>
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
