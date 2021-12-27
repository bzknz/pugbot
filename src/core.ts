import { strict as assert } from "assert";
import Discord, {
  Intents,
  MessageActionRow,
  MessageButton,
  MessageEmbed,
  MessageOptions,
  Permissions,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import Gamedig from "gamedig";
import path from "path";
import { createStore } from "redux";
import { filterObjectByKeys } from "./utils";

const Rcon: any = require("rcon");

dotenv.config();

// Data paths
const BASE_PATH = `${__dirname}/../data`;
const GAMES_PATH = `${BASE_PATH}/games`;
const CHANNELS_PATH = `${BASE_PATH}/channels`;

// Gamedig
const GAME_ID = "tf2";

// Timeout lengths
const DEFAULT_READY_FOR = 1000 * 60 * 10; // 10 min
const MAX_READY_FOR = 1000 * 60 * 30; // 30 min
const MIN_READY_FOR = 1000 * 60 * 5; // 5 min
let READY_TIMEOUT = 1000 * 60; // 60 seconds (value changed in testing code)
let MAP_VOTE_TIMEOUT = 1000 * 60; // 60 seconds (value changed in testing code)

const RCON_TIMEOUT = 5000;
const MOCK_ASYNC_SLEEP_FOR = 500; // Used in testing for: looking for server, rcon commands etc
const FIND_SERVER_ATTEMPTS = 60;
const FIND_SERVER_INTERVAL = 5000;

// Button ids and button prefixes
const MAP_VOTE_PREFIX = "map-vote-";
const VACATE_BUTTON_PREFIX = "vacate-";
const READY_BUTTON = "ready";

// Bot messages
const CHANNEL_NOT_SET_UP = `This channel has not been set up.`;
const NO_GAME_STARTED = `No game started. Use \`/start\` or \`/add\` to start one.`;
const NEW_GAME_STARTED = `New game started.`;
const STARTING_FROM_ADD = `No game started. Starting one now.`;
const GAME_ALREADY_STARTED = "A game has already been started.";
const STOPPED_GAME = `Stopped game.`;
const NO_PERMISSION_MSG = "You do not have permission to do this.";

// Redux actions
const SET_CHANNEL_GAME_MODE = "SET_CHANNEL_GAME_MODE";
const CREATE_GAME = "CREATE_GAME";
const REMOVE_GAME = "REMOVE_GAME";
const UPDATE_GAME = "UPDATE_GAME";
const ADD_PLAYER = "ADD_PLAYER";
const REMOVE_PLAYER = "REMOVE_PLAYER";
const REMOVE_PLAYERS = "REMOVE_PLAYERS";
const READY_PLAYER = "READY_PLAYER";
const PLAYER_MAP_VOTE = "PLAYER_MAP_VOTE";

const client = new Discord.Client({ intents: [Intents.FLAGS.GUILDS] });

export enum Commands {
  Setup = "setup",
  Start = "start",
  Status = "status",
  Maps = "maps",
  Add = "add",
  Remove = "remove",
  Kick = "kick",
  Vacate = "vacate",
  Ready = "ready",
  MapVote = "vote",
  Stop = "stop",
  ClearAFKs = "clear-afks",
}

type Player = {
  id: string;
  queuedAt: number;
  readyUntil: number;
  mapVote: null | string;
};

enum GameState {
  AddRemove = "ADD_REMOVE",
  ReadyCheck = "READY_CHECK",
  MapVote = "MAP_VOTE",
  MapVoteComplete = "MAP_VOTE_COMPLETE",
  FindingServer = "FINDING_SERVER",
  SettingMap = "SETTING_MAP",
  PlayersConnect = "PLAYERS_CONNECT",
}

export enum GameMode {
  BBall = "BBALL",
  Highlander = "HIGHLANDER",
  Sixes = "SIXES",
  Ultiduo = "ULTIDUO",
  Test = "TEST", // Just one player
}

type Players = { [playerId: string]: Player };

type Game = {
  mode: GameMode;
  channelId: string;
  state: GameState;
  startedAt: number;
  players: Players;
  readyCheckAt: null | number; // Used to track player readiness to a static value
  readyTimeout: null | NodeJS.Timeout;
  mapVoteAt: null | number;
  mapVoteTimeout: null | NodeJS.Timeout;
  map: null | string;
  findingServerAt: null | number;
  settingMapAt: null | number;
  socketAddress: null | string;
  playersConnectAt: null | number;
};

type Games = { [channelId: string]: Game };

type Channel = {
  id: string;
  mode: GameMode;
};

type Channels = { [channelId: string]: Channel };

type RootState = { games: Games; channels: Channels };

type SetChannelGameMode = {
  type: typeof SET_CHANNEL_GAME_MODE;
  payload: { channelId: string; mode: GameMode };
};

type CreateGame = {
  type: typeof CREATE_GAME;
  payload: Game;
};

type StopGame = {
  type: typeof REMOVE_GAME;
  payload: string;
};

type UpdateGame = {
  type: typeof UPDATE_GAME;
  payload: {
    channelId: string;
  } & Partial<Game>;
};

type AddPlayer = {
  type: typeof ADD_PLAYER;
  payload: { channelId: string; player: Player };
};

type RemovePlayer = {
  type: typeof REMOVE_PLAYER;
  payload: { channelId: string; playerId: string };
};

type RemovePlayers = {
  type: typeof REMOVE_PLAYERS;
  payload: { channelId: string; playerIds: string[] };
};

type ReadyPlayer = {
  type: typeof READY_PLAYER;
  payload: { channelId: string; playerId: string; readyUntil: number };
};

type PlayerMapVote = {
  type: typeof PLAYER_MAP_VOTE;
  payload: { channelId: string; playerId: string; mapVote: string };
};

type Action =
  | SetChannelGameMode
  | CreateGame
  | StopGame
  | UpdateGame
  | AddPlayer
  | RemovePlayer
  | RemovePlayers
  | ReadyPlayer
  | PlayerMapVote;

const getIsTestMode = () => process.env.TEST_MODE === "true";

const gameModeToNumPlayers = (gameMode: GameMode): number => {
  switch (gameMode) {
    case GameMode.BBall:
      return 4;
    case GameMode.Highlander:
      return 18;
    case GameMode.Sixes:
      return 12;
    case GameMode.Ultiduo:
      return 4;
    case GameMode.Test:
      return 1;
    default:
      throw new Error("Unknown game type.");
  }
};

const mentionPlayer = (playerId: string) => `<@${playerId}>`;

const reducer = (
  state: RootState = { games: {}, channels: {} },
  action: Action
): RootState => {
  // console.log(action);
  switch (action.type) {
    case SET_CHANNEL_GAME_MODE: {
      const channelId = action.payload.channelId;
      const prevChannel = { ...(state.channels[channelId] ?? {}) };
      return {
        ...state,
        channels: {
          ...state.channels,
          [channelId]: {
            ...prevChannel,
            id: channelId,
            mode: action.payload.mode,
          },
        },
      };
    }
    case CREATE_GAME: {
      const channelId = action.payload.channelId;
      return {
        ...state,
        games: { ...state.games, [channelId]: action.payload },
      };
    }
    case REMOVE_GAME: {
      const channelId = action.payload;
      const { [channelId]: _, ...nextGames } = state.games;
      return {
        ...state,
        games: nextGames,
      };
    }
    case UPDATE_GAME: {
      const { channelId, ...rest } = action.payload;
      const game = state.games[channelId];
      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...game,
            ...rest,
          },
        },
      };
    }
    case ADD_PLAYER: {
      const channelId = action.payload.channelId;
      const game = state.games[channelId];
      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...game,
            players: {
              ...game.players,
              [action.payload.player.id]: action.payload.player,
            },
          },
        },
      };
    }
    case REMOVE_PLAYER: {
      const channelId = action.payload.channelId;
      const playerId = action.payload.playerId;
      const game = state.games[channelId];
      const { [playerId]: _removed, ...nextPlayers } = game.players;
      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...game,
            players: nextPlayers,
          },
        },
      };
    }
    case REMOVE_PLAYERS: {
      const channelId = action.payload.channelId;
      const playerIds = action.payload.playerIds;
      const game = state.games[channelId];
      const nextPlayers = filterObjectByKeys(game.players, playerIds);

      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...game,
            players: nextPlayers,
          },
        },
      };
    }
    case READY_PLAYER: {
      const channelId = action.payload.channelId;
      const playerId = action.payload.playerId;
      const game = state.games[channelId];
      const player = game.players[playerId];
      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...state.games[channelId],
            players: {
              ...game.players,
              [playerId]: { ...player, readyUntil: action.payload.readyUntil },
            },
          },
        },
      };
    }
    case PLAYER_MAP_VOTE: {
      const channelId = action.payload.channelId;
      const playerId = action.payload.playerId;
      const game = state.games[channelId];
      const player = game.players[playerId];
      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: {
            ...state.games[channelId],
            players: {
              ...game.players,
              [playerId]: { ...player, mapVote: action.payload.mapVote },
            },
          },
        },
      };
    }
    default:
      console.error(`Unhandled action ${JSON.stringify(action)}`);
      return state;
  }
};

const store = createStore(reducer);

const getDiscordChannel = (channelId: string) =>
  client.channels.cache.get(channelId);

const sendMsg = async (
  channelId: string,
  embedText: string,
  mainText?: string
) => {
  if (getIsTestMode()) {
    console.log(channelId, embedText, mainText);
    return;
  }
  // Send message on Discord
  // console.log(`${channelId}: ${embedText}`);
  const channel = getDiscordChannel(channelId);

  const msgObj: MessageOptions = { embeds: [getEmbed(embedText)] };
  if (mainText) {
    msgObj.content = mainText;
  }

  if (channel?.isText()) {
    channel.send(msgObj);
  }
};

const sendDM = (playerId: string, msg: string) => {
  const user = client.users.cache.get(playerId);
  if (user) {
    user.send(msg);
  }
};

const setUpDataDirs = () => {
  if (!fs.existsSync(CHANNELS_PATH)) {
    fs.mkdirSync(CHANNELS_PATH);
  }
  if (!fs.existsSync(GAMES_PATH)) {
    fs.mkdirSync(GAMES_PATH);
  }
};

const getChannelJSONPath = (channelId: string) =>
  `${CHANNELS_PATH}/${channelId}.json`;

type SavedChannel = { channelId: string; mode: GameMode; savedAt: number };

const saveChannelGameMode = (channelId: string, mode: GameMode) => {
  const channel: SavedChannel = { channelId, mode, savedAt: Date.now() };
  fs.writeFileSync(
    getChannelJSONPath(channelId),
    JSON.stringify(channel, null, 2),
    "utf-8"
  );
};

const loadChannels = () => {
  const fileNames = fs.readdirSync(CHANNELS_PATH);
  for (const fileName of fileNames.filter((f) => f.includes(".json"))) {
    const channel: SavedChannel = JSON.parse(
      fs.readFileSync(`${CHANNELS_PATH}/${fileName}`, "utf-8")
    );
    store.dispatch({
      type: SET_CHANNEL_GAME_MODE,
      payload: { channelId: channel.channelId, mode: channel.mode },
    });
  }
};

const setChannelGameMode = (channelId: string, mode: GameMode): string => {
  store.dispatch({
    type: SET_CHANNEL_GAME_MODE,
    payload: { channelId, mode },
  });
  saveChannelGameMode(channelId, mode);
  return `Game mode set to ${mode}.`;
};

const getChannel = (channelId: string) => {
  const state = store.getState();
  return state.channels[channelId];
};

const getGame = (channelId: string) => {
  const state = store.getState();
  return state.games[channelId];
};

const checkPlayerAdded = (channelId: string, playerId: string) => {
  const game = getGame(channelId);
  return !!game.players[playerId];
};

const startGame = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const isExisting = !!getGame(channelId);
  if (isExisting) {
    return GAME_ALREADY_STARTED;
  }

  const channelType = channel.mode;

  const game: Game = {
    mode: channelType,
    channelId,
    state: GameState.AddRemove,
    startedAt: Date.now(),
    players: {},
    readyCheckAt: null,
    readyTimeout: null,
    mapVoteAt: null,
    mapVoteTimeout: null,
    map: null,
    findingServerAt: null,
    socketAddress: null,
    settingMapAt: null,
    playersConnectAt: null,
  };

  store.dispatch({ type: CREATE_GAME, payload: game });
  return NEW_GAME_STARTED;
};

const updateGame = (action: UpdateGame) => {
  store.dispatch(action);
};

const stopGame = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const game = getGame(channelId);
  if (!game) {
    return NO_GAME_STARTED;
  }

  if (game.state !== GameState.AddRemove) {
    return "Can't stop the game now.";
  }

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
  return STOPPED_GAME;
};

const getGameModeMaps = (mode: GameMode) => {
  const maps = JSON.parse(fs.readFileSync(`${BASE_PATH}/maps.json`, "utf-8"));
  return maps[mode];
};

const addPlayer = (channelId: string, playerId: string): string[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const game = getGame(channelId);
  if (!game) {
    const msgs = [STARTING_FROM_ADD];
    msgs.push(startGame(channelId));
    msgs.push(...addPlayer(channelId, playerId));
    return msgs;
  }

  if (game.state !== GameState.AddRemove) {
    return [`Can't add ${mentionPlayer(playerId)} right now. Ignoring.`];
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (isAdded) {
    return [`${mentionPlayer(playerId)} is already added. Ignoring.`];
  }

  const prevNumPlayers = getPlayers(game).length;
  const nextNumPlayers = prevNumPlayers + 1;
  const totalPlayers = gameModeToNumPlayers(game.mode);

  // Sanity check
  if (nextNumPlayers > totalPlayers) {
    console.error(
      `Bug: More than total num players added to game in channelId: ${channelId}.`
    );
    return [`Bug: More than total num players added to game`];
  }

  const timestamp = Date.now();
  const player: Player = {
    id: playerId,
    queuedAt: timestamp,
    readyUntil: timestamp + DEFAULT_READY_FOR,
    mapVote: null,
  };

  store.dispatch({
    type: ADD_PLAYER,
    payload: { channelId, player },
  });

  const msgs = [`Added: ${mentionPlayer(playerId)}`, getStatus(channelId)];

  if (nextNumPlayers === totalPlayers) {
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyCheckAt: timestamp },
    });

    msgs.push(`The game is full.`);

    const unreadyAfter = Date.now();
    const unreadyPlayerIds = getUnreadyPlayerIds(channelId, unreadyAfter);
    if (unreadyPlayerIds.length === 0) {
      startMapVote(channelId);
    } else {
      // Setup timeout if not all players ready up in time.
      const readyTimeout = setTimeout(() => {
        // If this runs, remove the unready players
        const unreadyPlayerIds = getUnreadyPlayerIds(channelId, unreadyAfter);
        store.dispatch({
          type: REMOVE_PLAYERS,
          payload: { channelId, playerIds: unreadyPlayerIds },
        });
        updateGame({
          type: UPDATE_GAME,
          payload: {
            channelId,
            state: GameState.AddRemove,
            readyTimeout: null,
          },
        });

        sendMsg(
          channelId,
          `:slight_frown: Removed ${
            unreadyPlayerIds.length
          } unready player(s) as they did not ready up in time.\n${getStatus(
            channelId
          )}`,
          `Removed: ${unreadyPlayerIds.map((p) => mentionPlayer(p)).join(" ")}`
        );
      }, READY_TIMEOUT);

      updateGame({
        type: UPDATE_GAME,
        payload: {
          channelId,
          state: GameState.ReadyCheck,
          readyTimeout,
        },
      });

      // Ask unready players to ready
      const row = new MessageActionRow().addComponents(
        new MessageButton()
          .setCustomId(READY_BUTTON)
          .setLabel("Ready up!")
          .setStyle("SUCCESS")
      );

      const channel = getDiscordChannel(channelId);

      const embed = getEmbed(
        `:hourglass: ${
          unreadyPlayerIds.length
        } player(s) are not ready. Waiting ${
          READY_TIMEOUT / 1000
        } seconds for them. Click the button (or use \`/ready\`) to ready up.`
      );

      if (channel?.isText()) {
        channel
          .send({
            embeds: [embed],
            components: [row],
            content: `Unready: ${unreadyPlayerIds
              .map((p) => mentionPlayer(p))
              .join(" ")}`,
          })
          .then((embed) => {
            for (const unreadyPlayerId of unreadyPlayerIds) {
              sendDM(
                unreadyPlayerId,
                `Please ready up for you ${game.mode} PUG: ${embed.url}`
              );
            }
          });
      }
    }
  }
  return msgs;
};

const removePlayers = (channelId: string, playerIds: string[]) => {
  store.dispatch({ type: REMOVE_PLAYERS, payload: { channelId, playerIds } });
  sendMsg(
    channelId,
    `:warning: Removed ${
      playerIds.length
    } player(s) from this game as they are in another game that is about to start.\n${getStatus(
      channelId
    )}`,
    `Removed: ${playerIds.map((p) => mentionPlayer(p)).join(" ")}`
  );
};

const removePlayersFromOtherGames = (channelId: string) => {
  // Remove players from other games
  const game = getGame(channelId);
  const state = store.getState();
  const otherGames = Object.values(state.games).filter(
    (g) => g.channelId !== channelId
  );
  const players = getPlayers(game);

  if (otherGames.length > 0) {
    for (const otherGame of otherGames) {
      const playersIdsToRemove = [];
      for (const player of players) {
        const otherGamePlayersIds = getPlayers(otherGame).map((p) => p.id);
        if (otherGamePlayersIds.includes(player.id)) {
          playersIdsToRemove.push(player.id);
        }
      }
      if (playersIdsToRemove.length > 0) {
        removePlayers(otherGame.channelId, playersIdsToRemove);
      }
    }
  }
};

const getMapVoteButtons = (channelId: string): Discord.MessageActionRow[] => {
  const game = getGame(channelId);

  const maps = getGameModeMaps(game.mode);

  const rows = [new MessageActionRow()];

  for (let x = 1; x <= maps.length; x++) {
    let lastRow = rows[rows.length - 1];
    if (lastRow.components.length === 5) {
      // Need a new row (max 5 buttons per row [Discord limitation])
      rows.push(new MessageActionRow());
      lastRow = rows[rows.length - 1];
    }
    const mapName = maps[x - 1];
    lastRow.addComponents(
      new MessageButton()
        .setCustomId(`${MAP_VOTE_PREFIX}${mapName}`)
        .setLabel(mapName)
        .setStyle("SECONDARY")
    );
  }

  return rows;
};

const startMapVote = (channelId: string) => {
  // All players are now ready - start map vote
  removePlayersFromOtherGames(channelId);

  const existingGame = getGame(channelId);
  if (existingGame.readyTimeout) {
    clearTimeout(existingGame.readyTimeout);
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyTimeout: null },
    });
  }

  sendMsg(channelId, `All players are ready.`);

  const maps = getGameModeMaps(existingGame.mode);

  if (maps.length === 1) {
    // Special case for only one map (BBall)
    mapVoteComplete(channelId);
  } else {
    const mapVoteTimeout = setTimeout(() => {
      const game = getGame(channelId);
      const players = getPlayers(game);
      const numVotes = players.filter((p) => p.mapVote).length;
      sendMsg(
        channelId,
        `${numVotes}/${players.length} players voted within the time limit.`
      );
      mapVoteComplete(channelId);
    }, MAP_VOTE_TIMEOUT);

    updateGame({
      type: UPDATE_GAME,
      payload: {
        channelId,
        state: GameState.MapVote,
        mapVoteAt: Date.now(),
        mapVoteTimeout,
      },
    });

    const rows = getMapVoteButtons(channelId);

    const game = getGame(channelId);
    const players = getPlayers(game);
    const embed = getEmbed(
      `:ballot_box: Map vote starting now. Please click the map you want to play. Waiting ${
        MAP_VOTE_TIMEOUT / 1000
      } seconds for votes.`
    );

    const channel = getDiscordChannel(channelId);
    if (channel?.isText()) {
      channel.send({
        embeds: [embed],
        components: rows,
        content: `Vote now: ${players
          .map((p) => mentionPlayer(p.id))
          .join(" ")}`,
      });
    }
  }
};

const removePlayer = (channelId: string, playerId: string): string[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return [NO_GAME_STARTED];
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return [`${mentionPlayer(playerId)} is not added. Ignoring.`];
  }

  // Check for expected game state
  if (
    ![GameState.AddRemove, GameState.ReadyCheck].includes(existingGame.state)
  ) {
    return [`Can't remove ${mentionPlayer(playerId)} right now. Ignoring.`];
  }

  store.dispatch({ type: REMOVE_PLAYER, payload: { channelId, playerId } });
  updateGame({
    type: UPDATE_GAME,
    payload: { channelId, state: GameState.AddRemove },
  });

  const msgs = [];

  if (existingGame.readyTimeout) {
    clearTimeout(existingGame.readyTimeout);
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyTimeout: null },
    });
    msgs.push(`Cancelling ready check.`);
  }

  msgs.push(`Removed: ${mentionPlayer(playerId)}`);
  msgs.push(getStatus(channelId));
  return msgs;
};

const kickPlayer = (channelId: string, playerId: string) => {
  return removePlayer(channelId, playerId);
};

const getStatus = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return NO_GAME_STARTED;
  }

  const game = getGame(channelId);
  const players = getPlayers(game);
  const numPlayers = players.length;
  const totalPlayers = gameModeToNumPlayers(game.mode);

  let out = `Status (${numPlayers}/${totalPlayers}): `;
  if (players.length === 0) {
    out += "Empty";
  } else {
    const now = Date.now();
    for (const player of players) {
      out += `${mentionPlayer(player.id)}`;
      const isReady = isPlayerReady(now, player.readyUntil);
      if (isReady) {
        out += `:ballot_box_with_check: `;
      } else {
        out += `:zzz: `;
      }
    }
  }
  return out;
};

const readyPlayer = (
  channelId: string,
  playerId: string,
  time: number
): string => {
  // Ready the player up and then check if all players are ready
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return NO_GAME_STARTED;
  }

  if (
    ![GameState.AddRemove, GameState.ReadyCheck].includes(existingGame.state)
  ) {
    return `Can't ready ${mentionPlayer(playerId)} right now. Ignoring.`;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return `${mentionPlayer(playerId)} is not added. Ignoring.`;
  }

  const now = Date.now();
  const normalizedTime = Math.max(Math.min(time, MAX_READY_FOR), MIN_READY_FOR);
  const readyUntil = now + normalizedTime;
  store.dispatch({
    type: READY_PLAYER,
    payload: { channelId, playerId, readyUntil },
  });

  const readyUntilDate = new Date(readyUntil);

  const game = getGame(channelId);
  // Use readyCheckAt if we are in ready up state otherwise some players could become unready (timed out during ready check)
  const unreadyAfter =
    game.state === GameState.ReadyCheck && game.readyCheckAt
      ? game.readyCheckAt
      : Date.now();
  const unreadyPlayerIds = getUnreadyPlayerIds(channelId, unreadyAfter);
  const players = getPlayers(game);
  if (
    unreadyPlayerIds.length === 0 &&
    players.length === gameModeToNumPlayers(game.mode)
  ) {
    startMapVote(channelId);
  }
  return `${mentionPlayer(playerId)} is ready for ${Math.round(
    normalizedTime / 1000 / 60
  )}min (until ${readyUntilDate.toLocaleTimeString("en-ZA")}).`;
};

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const splitSocketAddress = (
  socketAddress: string
): { ip: string; port: number } => {
  const split = socketAddress.split(":");
  const ip = split[0];
  const port = Number(split[1]);
  return { ip, port };
};

const getEnvSocketAddresses = (): string[] => {
  if (!process.env.TF2_SERVERS) {
    throw new Error("No socketAddresses/tf2 servers set!");
  } else {
    return process.env.TF2_SERVERS.split(",");
  }
};

const getServerDetails = async (
  socketAddress: string
): Promise<null | { numPlayers: number; map: string; name: string }> => {
  const { ip, port } = splitSocketAddress(socketAddress);

  try {
    const response = await Gamedig.query({
      type: GAME_ID,
      maxAttempts: 3,
      givenPortOnly: true,
      host: ip,
      port,
    });
    return {
      numPlayers: response.players.length,
      map: response.map,
      name: response.name,
    };
  } catch (e) {
    console.log(`Error getting server response for ${socketAddress}.`);
    return null;
  }
};

type Server = {
  socketAddress: string;
  name: string;
};

const findAvailableServer = async (): Promise<Server | null> => {
  // Find a server with no players on it from set of available servers

  if (getIsTestMode()) {
    console.log("Not attempting to find a server as we are in test mode.");
    await sleep(MOCK_ASYNC_SLEEP_FOR);
    return { name: "test-server", socketAddress: "127.0.0.1:27015" };
  }

  const socketAddresses = getEnvSocketAddresses();

  if (socketAddresses) {
    for (const socketAddress of socketAddresses) {
      const details = await getServerDetails(socketAddress);
      if (details?.numPlayers === 0) {
        return { socketAddress: socketAddress, name: details.name };
      }
    }
  }
  return null;
};

const setMapOnServer = async (
  socketAddress: string,
  map: string
): Promise<string> => {
  // Send rcon command to change the map on the server
  if (getIsTestMode()) {
    console.log("Not setting map on server as we are in test mode.");
    await sleep(MOCK_ASYNC_SLEEP_FOR);
    return "Not setting map on server as we are in test mode.";
  }

  const { ip, port } = splitSocketAddress(socketAddress);
  const password = process.env.RCON_PASSWORD;
  const conn = new Rcon(ip, port, password);

  const setMapPromise: Promise<string> = new Promise((resolve) => {
    const msgs: (null | string)[] = [];

    const resolveHandler = () => {
      const toResolve = msgs.filter((m) => m).join("\n");
      resolve(
        toResolve
          ? toResolve
          : ":white_check_mark: Looks like the map was changed successfully."
      );
    };

    conn
      .on("auth", () => {
        console.log("Authenticated");
        const command = `changelevel ${map}`;
        console.log(command);
        conn.send(command);
      })
      .on("response", (str: string) => {
        const msg = str ? "Set map response:\n```" + str + "```" : null;
        console.log(msg);
        msgs.push(msg);
        if (msgs.length == 2) {
          // Auth and response from kick command
          resolveHandler();
        }
      })
      .on("error", (err: string) => {
        const msg =
          "Error:\n```" + `${err ? err : "No error message."}` + "```";
        console.log(msg);
        msgs.push(msg);
        resolveHandler();
      })
      .on("end", () => {
        const msg = "Connection closed.";
        console.log(msg);
        msgs.push(msg);
        resolveHandler();
      });
  });

  conn.connect();

  const timeoutPromise: Promise<string> = new Promise((resolve) => {
    sleep(RCON_TIMEOUT).then(() => {
      resolve("Error: Timed out.");
    });
  });

  const msg = await Promise.any([setMapPromise, timeoutPromise]);
  return msg;
};

const vacate = async (socketAddress: string): Promise<string> => {
  // Send rcon command to kick players from the server

  if (getIsTestMode()) {
    console.log("Not vacating as we are in test mode.");
    await sleep(MOCK_ASYNC_SLEEP_FOR);
    return "Not vacating as we are in test mode.";
  }

  const { ip, port } = splitSocketAddress(socketAddress);
  const password = process.env.RCON_PASSWORD;
  const conn = new Rcon(ip, port, password);

  const vacatePromise: Promise<string> = new Promise((resolve) => {
    const msgs: (null | string)[] = [];

    const resolveHandler = () => {
      const toResolve = msgs.filter((m) => m).join("\n");
      resolve(
        toResolve
          ? toResolve
          : "Looks like no players were kicked as no players were on the server."
      );
    };

    conn
      .on("auth", () => {
        console.log("Authenticated");
        console.log("Sending command: kickall");
        conn.send("kickall");
      })
      .on("response", (str: string) => {
        const msg = str ? "Vacate response:\n```" + str + "```" : null;
        console.log(msg);
        msgs.push(msg);
        if (msgs.length == 2) {
          // Auth and response from kick command
          resolveHandler();
        }
      })
      .on("error", (err: string) => {
        const msg = "Error:\n```" + `${err ? err : "No error message"}` + "```";
        console.log(msg);
        msgs.push(msg);
        resolveHandler();
      })
      .on("end", () => {
        const msg = "Connection closed.";
        console.log(msg);
        msgs.push(msg);
        resolveHandler();
      });
  });

  conn.connect();

  const timeoutPromise: Promise<string> = new Promise((resolve) => {
    sleep(RCON_TIMEOUT).then(() => {
      resolve("Error: Timed out.");
    });
  });

  const msg = await Promise.any([vacatePromise, timeoutPromise]);
  return msg;
};

const getMapVoteCounts = (channelId: string) => {
  const game = getGame(channelId);
  const players = getPlayers(game);

  const voteCounts: { [map: string]: number } = {};
  const maps = getGameModeMaps(game.mode);
  for (const map of maps) {
    voteCounts[map] = 0;
  }

  const votes = players
    .filter((p) => p.mapVote !== null)
    .map((p) => p.mapVote) as string[];
  for (const vote of votes) {
    voteCounts[vote] += 1;
  }
  return voteCounts;
};

const mapVoteComplete = async (channelId: string) => {
  const msgs = [];
  const existingGame = getGame(channelId);
  const maps = getGameModeMaps(existingGame.mode);
  let winningMap = maps[0]; // Use the first map by default

  if (maps.length === 1) {
    msgs.push(
      `:map: **Playing ${winningMap} as it's the only available map.**`
    );
  } else {
    const voteCounts = getMapVoteCounts(channelId);
    const maxVoteCount = Math.max(...Object.values(voteCounts));
    const withMaxVotes = Object.entries(voteCounts)
      .filter(([_, val]) => val === maxVoteCount)
      .map(([key, _]) => key);
    if (withMaxVotes.length > 1) {
      // Pick a random map from the winners
      msgs.push(
        `${withMaxVotes.join(", ")} tied with ${maxVoteCount} votes each.`
      );
      const randIndex = Math.round(Math.random() * (withMaxVotes.length - 1));
      winningMap = withMaxVotes[randIndex];
      msgs.push(`:map: **${winningMap} was randomly selected as the winner.**`);
    } else {
      winningMap = withMaxVotes[0]; // Only one in the set of winning maps
      msgs.push(`:map: **${winningMap} won with ${maxVoteCount} votes.**`);
    }
  }

  updateGame({
    type: UPDATE_GAME,
    payload: {
      channelId,
      map: winningMap,
      state: GameState.FindingServer,
      findingServerAt: Date.now(),
      mapVoteTimeout: null,
    },
  });

  msgs.push(
    `:mag_right: Attempting to find an available server (${FIND_SERVER_ATTEMPTS} attempts at a ~${
      FIND_SERVER_INTERVAL / 1000
    }s interval [~${(
      (FIND_SERVER_ATTEMPTS * FIND_SERVER_INTERVAL) /
      1000 /
      60
    ).toFixed(
      0
    )}min timeout])... An admin can \`/vacate\` to kick all players from a server.`
  );

  sendMsg(channelId, msgs.join("\n"));

  let server: null | Server = null;
  for (let x = 0; x < FIND_SERVER_ATTEMPTS; x++) {
    server = await findAvailableServer();
    if (server) {
      break;
    } else {
      await sleep(FIND_SERVER_INTERVAL);
    }
  }

  if (server) {
    updateGame({
      type: UPDATE_GAME,
      payload: {
        channelId,
        state: GameState.SettingMap,
        socketAddress: server.socketAddress,
        settingMapAt: Date.now(),
      },
    });

    sendMsg(
      channelId,
      `:handshake: Found server: ${server.name} (${server.socketAddress}). Attempting to set the map to **${winningMap}**...`
    );

    const setMapStatus = await setMapOnServer(server.socketAddress, winningMap);

    sendMsg(channelId, setMapStatus);

    updateGame({
      type: UPDATE_GAME,
      payload: {
        channelId,
        state: GameState.PlayersConnect,
        playersConnectAt: Date.now(),
      },
    });

    const game = getGame(channelId);
    const playerIds = getPlayers(game).map((p) => p.id);

    for (const playerId of playerIds) {
      sendDM(
        playerId,
        `Your ${game.mode} PUG is ready. Please join the server at: steam://connect/${game.socketAddress}/games`
      );
    }

    sendMsg(
      channelId,
      `:fireworks: **Good to go. Join the server now. Check your DMs for a link to join.**`,
      `${playerIds.map((p) => mentionPlayer(p)).join(" ")}`
    );
  } else {
    sendMsg(
      channelId,
      `:exclamation: **Could not find an available server. If one is available, please connect now.**\nStopped game.`
    );
  }

  // Set timers to null if they are set (can't stringify)
  updateGame({
    type: UPDATE_GAME,
    payload: { channelId, readyTimeout: null, mapVoteTimeout: null },
  });

  // Store game as JSON for debugging and historic data access for potentially map selection/recommendations (TODO)
  const game = getGame(channelId);
  const path = `${GAMES_PATH}/${Date.now()}.json`;

  const stringified = JSON.stringify(game, null, 2);
  fs.writeFileSync(path, stringified, "utf-8");

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
};

const getCanVote = (
  channelId: string,
  playerId: string
): { isAllowed: false; msg: string } | { isAllowed: true } => {
  const channel = getChannel(channelId);
  if (!channel) {
    return { isAllowed: false, msg: CHANNEL_NOT_SET_UP };
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return { isAllowed: false, msg: NO_GAME_STARTED };
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return { isAllowed: false, msg: `You are not added. Ignoring vote.` };
  }

  if (![GameState.AddRemove, GameState.MapVote].includes(existingGame.state)) {
    return { isAllowed: false, msg: `You cannot vote now. Ignoring vote.` };
  }

  return { isAllowed: true };
};

const mapVote = (
  channelId: string,
  playerId: string,
  mapVote: string
): string => {
  const allowedStatus = getCanVote(channelId, playerId);

  if (!allowedStatus.isAllowed) {
    return allowedStatus.msg;
  }

  store.dispatch({
    type: PLAYER_MAP_VOTE,
    payload: { channelId, playerId, mapVote },
  });

  // Notify users about player vote
  const game = getGame(channelId);

  const numVotes = getPlayers(game).filter((p) => p.mapVote).length;
  if (
    game.state === GameState.MapVote &&
    numVotes === gameModeToNumPlayers(game.mode)
  ) {
    if (game.mapVoteTimeout) {
      clearTimeout(game.mapVoteTimeout);
      updateGame({
        type: UPDATE_GAME,
        payload: { channelId, mapVoteTimeout: null },
      });
    }
    // All players voted in the alloted time
    sendMsg(channelId, `All players have voted.`);
    mapVoteComplete(channelId);
  }

  return `You voted for ${mapVote}.`;
};

const isPlayerReady = (unreadyAfter: number, playerReadyUntil: number) =>
  playerReadyUntil >= unreadyAfter;

const sortPlayers = (a: Player, b: Player) =>
  a.queuedAt <= b.queuedAt ? -1 : 1;

const getPlayers = (game: Game) =>
  Object.values(game.players).sort(sortPlayers);

const getUnreadyPlayerIds = (
  channelId: string,
  unreadyAfter: number
): string[] => {
  const game = getGame(channelId);
  const players = getPlayers(game);
  const unreadyPlayerIds = [];
  for (const player of players) {
    const isReady = isPlayerReady(unreadyAfter, player.readyUntil);
    if (!isReady) {
      unreadyPlayerIds.push(player.id);
    }
  }
  return unreadyPlayerIds;
};

const listMaps = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const maps = getGameModeMaps(channel.mode);

  return `Available maps for ${channel.mode}:\n${maps.join("\n")}`;
};

// https://brianchildress.co/find-latest-file-in-directory-in-nodejs/
const orderRecentFiles = (dir: string) => {
  return fs
    .readdirSync(dir)
    .filter((file) => fs.lstatSync(path.join(dir, file)).isFile())
    .map((file) => ({ file, mtime: fs.lstatSync(path.join(dir, file)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
};

const getEmbed = (msg: string) => new MessageEmbed().setDescription(msg);

const handleMultiResponse = (
  interaction: Discord.CommandInteraction<Discord.CacheType>,
  msgs: string[]
) => {
  const msg = msgs.join(`\n`);
  interaction.reply({ embeds: [getEmbed(msg)] });
};

const hasPermission = (
  permissions: string | Readonly<Discord.Permissions> | undefined,
  permission: Discord.PermissionResolvable
): boolean => {
  if (typeof permissions !== "string" && permissions?.has(permission)) {
    return true;
  }
  return false;
};

export const run = () => {
  getEnvSocketAddresses(); // Sanity check TF2 servers set correctly in the .env file
  setUpDataDirs();
  loadChannels();

  client.login(process.env.DISCORD_BOT_TOKEN);

  client.once("ready", () => {
    console.log("Ready!");
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) {
      return;
    }

    const { commandName, channelId, user } = interaction;
    const playerId = user.id;
    const playerPermissions = interaction.member?.permissions;

    switch (commandName) {
      case Commands.Setup: {
        if (
          hasPermission(playerPermissions, Permissions.FLAGS.MANAGE_CHANNELS)
        ) {
          const mode = interaction.options.getString("mode") as GameMode;
          const msg = setChannelGameMode(channelId, mode);
          interaction.reply({ embeds: [getEmbed(msg)] });
        } else {
          interaction.reply({
            embeds: [
              getEmbed(
                `${NO_PERMISSION_MSG} You need the MANAGE_CHANNELS permission.`
              ),
            ],
            ephemeral: true,
          });
        }
        break;
      }
      case Commands.Start: {
        const msg = startGame(channelId);
        interaction.reply({ embeds: [getEmbed(msg)] });
        break;
      }
      case Commands.Status: {
        const msg = getStatus(channelId);
        interaction.reply({ embeds: [getEmbed(msg)] });
        break;
      }
      case Commands.Maps: {
        const msg = listMaps(channelId);
        interaction.reply({ embeds: [getEmbed(msg)] });
        break;
      }
      case Commands.Stop: {
        if (hasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)) {
          const msg = stopGame(channelId);
          interaction.reply({ embeds: [getEmbed(msg)] });
        } else {
          interaction.reply({
            embeds: [
              getEmbed(
                `${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`
              ),
            ],
            ephemeral: true,
          });
        }
        break;
      }
      case Commands.Add: {
        const msgs = addPlayer(channelId, playerId);
        handleMultiResponse(interaction, msgs);
        break;
      }
      case Commands.Remove: {
        const msgs = removePlayer(channelId, playerId);
        handleMultiResponse(interaction, msgs);
        break;
      }
      case Commands.Kick: {
        if (hasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)) {
          const targetPlayer = interaction.options.getUser("user");
          if (targetPlayer) {
            const msgs = kickPlayer(channelId, targetPlayer.id);
            handleMultiResponse(interaction, msgs);
          } else {
            interaction.reply({
              embeds: [getEmbed(`Could not find player to kick.`)],
            });
          }
        } else {
          interaction.reply({
            embeds: [
              getEmbed(
                `${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`
              ),
            ],
            ephemeral: true,
          });
        }
        break;
      }
      case Commands.Ready: {
        const minutesIn = interaction.options.getNumber("minutes");
        const readyFor = minutesIn ? minutesIn * 1000 * 60 : DEFAULT_READY_FOR;
        const msg = readyPlayer(channelId, playerId, readyFor);
        interaction.reply({ embeds: [getEmbed(msg)] });
        break;
      }
      case Commands.Vacate: {
        if (hasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)) {
          // Send the user button options asking which server to vacate from.

          await interaction.deferReply({ ephemeral: true });

          const row = new MessageActionRow();
          const socketAddresses = getEnvSocketAddresses();
          for (const socketAddress of socketAddresses) {
            const details = await getServerDetails(socketAddress);
            row.addComponents(
              new MessageButton()
                .setCustomId(`${VACATE_BUTTON_PREFIX}${socketAddress}`)
                .setLabel(
                  `${
                    details?.name ?? "unknown"
                  } (${socketAddress}). No. connected: ${
                    details?.numPlayers ?? "unknown"
                  }. Map: ${details?.map ?? "unknown"}.`
                )
                .setStyle("DANGER")
            );
          }

          interaction.editReply({
            embeds: [
              getEmbed(
                "Please click the server you want to vacate. Make sure there is not a game currently happening on it!"
              ),
            ],
            components: [row],
          });
        } else {
          interaction.reply({
            embeds: [
              getEmbed(
                `${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`
              ),
            ],
            ephemeral: true,
          });
        }
        break;
      }
      case Commands.MapVote: {
        // Send map vote buttons privately to the user.
        const canVoteStatus = getCanVote(channelId, playerId);

        if (!canVoteStatus.isAllowed) {
          interaction.reply({ content: canVoteStatus.msg, ephemeral: true });
          return;
        }

        const rows = getMapVoteButtons(channelId);
        const embed = getEmbed("Please click the map you want to play.");

        interaction.reply({
          embeds: [embed],
          components: rows,
          ephemeral: true,
        });

        break;
      }
      // case Commands.ClearAFKs: {
      //   const msg = clearAFKs(channelId);
      //   interaction.reply({ embeds: [getEmbed(msg)] });
      //   break;
      // }
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const { customId, channelId, user } = interaction;
    const playerId = user.id;
    const playerPermissions = interaction.member?.permissions;

    if (customId.includes(MAP_VOTE_PREFIX)) {
      const map = customId.split(MAP_VOTE_PREFIX)[1];
      const msg = mapVote(channelId, playerId, map);
      interaction.reply({ ephemeral: true, embeds: [getEmbed(msg)] });
    } else if (customId === READY_BUTTON) {
      const msg = readyPlayer(channelId, playerId, DEFAULT_READY_FOR);
      interaction.reply({ embeds: [getEmbed(msg)], ephemeral: true });
    } else if (customId.includes(VACATE_BUTTON_PREFIX)) {
      if (hasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)) {
        await interaction.deferReply();
        const socketAddress = customId.split(VACATE_BUTTON_PREFIX)[1];
        const msg = await vacate(socketAddress);
        interaction.editReply({ content: msg });
      } else {
        interaction.reply({
          embeds: [
            getEmbed(
              `${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`
            ),
          ],
          ephemeral: true,
        });
      }
    }
  });
};

export const test = async () => {
  // Set so that external requests do not run (look for server and change map)
  process.env.TEST_MODE = "true";

  // Manually set timeouts to low values
  const overrideTimeout = 1000;
  READY_TIMEOUT = overrideTimeout;
  MAP_VOTE_TIMEOUT = overrideTimeout;

  store.subscribe(() => {
    const s = store.getState();
    // console.log(JSON.stringify(s) + "\n");
  });

  const testChannel1 = "test-channel-1";
  const testChannel2 = "test-channel-2";
  const testChannel3 = "test-channel-3";
  const testMap1 = "cp_snakewater_final1";
  const testMap2 = "cp_granary_pro_rc8";
  const testMap3 = "cp_reckoner_rc6";

  const testGame = async () => {
    // Test invalid commands when channel is not set up
    assert(startGame(testChannel1) === CHANNEL_NOT_SET_UP);
    assert.deepEqual(addPlayer(testChannel1, `1`), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(removePlayer(testChannel1, `1`), [CHANNEL_NOT_SET_UP]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) === CHANNEL_NOT_SET_UP
    );
    assert(mapVote(testChannel1, `invalid`, testMap1) === CHANNEL_NOT_SET_UP);
    assert(stopGame(testChannel1) === CHANNEL_NOT_SET_UP);
    assert(getStatus(testChannel1) === CHANNEL_NOT_SET_UP);
    assert(listMaps(testChannel1) === CHANNEL_NOT_SET_UP);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [CHANNEL_NOT_SET_UP]);

    // Setup channel
    assert(
      setChannelGameMode(testChannel1, GameMode.Sixes) ===
        `Game mode set to SIXES.`
    );

    // Test invalid commands when channel set up but no game started
    assert(mapVote(testChannel1, `invalid`, testMap1) === NO_GAME_STARTED);
    assert.deepEqual(removePlayer(testChannel1, `1`), [NO_GAME_STARTED]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) === NO_GAME_STARTED
    );
    assert(stopGame(testChannel1) === NO_GAME_STARTED);
    assert(getStatus(testChannel1) === NO_GAME_STARTED);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [NO_GAME_STARTED]);

    assert(
      listMaps(testChannel1) ===
        `Available maps for SIXES:\ncp_granary_pro_rc8\ncp_gullywash_f3\ncp_metalworks\ncp_process_f9a\ncp_prolands_rc2p\ncp_reckoner_rc6\ncp_snakewater_final1\ncp_sunshine\nkoth_clearcut_b15d\nkoth_product_rcx`
    );

    // Start a game with /add
    assert.deepEqual(addPlayer(testChannel1, `1`), [
      STARTING_FROM_ADD,
      NEW_GAME_STARTED,
      `Added: <@1>`,
      `Status (1/12): <@1>:ballot_box_with_check: `,
    ]);

    // Stop the game
    assert(stopGame(testChannel1) === STOPPED_GAME);

    // Change channel type
    assert(
      setChannelGameMode(testChannel1, GameMode.BBall) ===
        `Game mode set to BBALL.`
    );
    assert(
      setChannelGameMode(testChannel1, GameMode.Ultiduo) ===
        `Game mode set to ULTIDUO.`
    );
    assert(
      setChannelGameMode(testChannel1, GameMode.Highlander) ===
        `Game mode set to HIGHLANDER.`
    );
    assert(
      setChannelGameMode(testChannel1, GameMode.Test) ===
        `Game mode set to TEST.`
    );
    assert(
      setChannelGameMode(testChannel1, GameMode.Sixes) ===
        `Game mode set to SIXES.`
    );

    // Start game
    assert(startGame(testChannel1) === NEW_GAME_STARTED);

    // Empty game status
    assert(getStatus(testChannel1) === "Status (0/12): Empty");

    // Test invalid commands right after new game started
    assert(startGame(testChannel1) === GAME_ALREADY_STARTED);
    assert(
      mapVote(testChannel1, `invalid`, testMap1) ===
        `You are not added. Ignoring vote.`
    );
    assert.deepEqual(removePlayer(testChannel1, `1`), [
      `<@1> is not added. Ignoring.`,
    ]);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [
      `<@1> is not added. Ignoring.`,
    ]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) ===
        "<@1> is not added. Ignoring."
    );

    // Add 11 Status (not full)
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), [
        `Added: <@${x + 1}>`,
        getStatus(testChannel1),
      ]);
      await sleep(10); // Get a different timestamp for each player
    }

    // Check status
    assert(
      getStatus(testChannel1) ===
        "Status (11/12): <@1>:ballot_box_with_check: <@2>:ballot_box_with_check: <@3>:ballot_box_with_check: <@4>:ballot_box_with_check: <@5>:ballot_box_with_check: <@6>:ballot_box_with_check: <@7>:ballot_box_with_check: <@8>:ballot_box_with_check: <@9>:ballot_box_with_check: <@10>:ballot_box_with_check: <@11>:ballot_box_with_check: "
    );

    // Ready player 11
    assert(
      readyPlayer(testChannel1, "11", DEFAULT_READY_FOR).includes(
        "<@11> is ready for 10min (until "
      )
    );

    // Test ready player that is not added
    assert(
      readyPlayer(testChannel1, "invalid", DEFAULT_READY_FOR).includes(
        `<@invalid> is not added. Ignoring.`
      )
    );

    // Try add player again
    assert.deepEqual(addPlayer(testChannel1, `1`), [
      `<@1> is already added. Ignoring.`,
    ]);

    // Remove all 11 players
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(removePlayer(testChannel1, `${x + 1}`), [
        `Removed: <@${x + 1}>`,
        getStatus(testChannel1),
      ]);
    }

    // Add all players to fill game
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), [
        `Added: <@${x + 1}>`,
        getStatus(testChannel1),
      ]);
      await sleep(10); // Get a different timestamp for each player
    }

    assert.deepEqual(addPlayer(testChannel1, `12`), [
      `Added: <@12>`,
      getStatus(testChannel1),
      `The game is full.`,
    ]);

    // Check in map vote state
    assert(getPlayers(store.getState().games[testChannel1]).length === 12);
    assert(store.getState().games[testChannel1].state === GameState.MapVote);

    // Test invalid actions when in map vote state
    assert(startGame(testChannel1) === GAME_ALREADY_STARTED);
    assert.deepEqual(addPlayer(testChannel1, `1`), [
      `Can't add <@1> right now. Ignoring.`,
    ]);
    assert.deepEqual(removePlayer(testChannel1, `1`), [
      `Can't remove <@1> right now. Ignoring.`,
    ]);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [
      `Can't remove <@1> right now. Ignoring.`,
    ]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) ===
        `Can't ready <@1> right now. Ignoring.`
    );
    assert(
      mapVote(testChannel1, `invalid`, testMap1) ===
        `You are not added. Ignoring vote.`
    );
    assert(stopGame(testChannel1) === "Can't stop the game now.");

    // Players vote for one of three maps (even distribution)
    for (let x = 0; x < 12; x++) {
      const map = x < 4 ? testMap1 : x < 8 ? testMap2 : testMap3;
      assert(
        mapVote(testChannel1, `${x + 1}`, map) === `You voted for ${map}.`
      );
    }

    // Check the winning map one of the three test maps (should be randomly selected)
    const compareMapsTo = [testMap1, testMap2, testMap3] as string[];
    assert(store.getState().games[testChannel1].map !== null);
    assert(
      compareMapsTo.includes(store.getState().games[testChannel1].map as string)
    );
    assert(
      store.getState().games[testChannel1].state === GameState.FindingServer
    );
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 12
    );

    // Now the bot should look for an available server and set the map on the server

    // Check invalid commands when looking for server and setting map
    assert(startGame(testChannel1) === GAME_ALREADY_STARTED);
    assert.deepEqual(addPlayer(testChannel1, `1`), [
      `Can't add <@1> right now. Ignoring.`,
    ]);
    assert.deepEqual(removePlayer(testChannel1, `1`), [
      `Can't remove <@1> right now. Ignoring.`,
    ]);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [
      `Can't remove <@1> right now. Ignoring.`,
    ]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) ===
        `Can't ready <@1> right now. Ignoring.`
    );
    console.log(mapVote(testChannel1, `invalid`, testMap1));
    assert(
      mapVote(testChannel1, `invalid`, testMap1) ===
        `You are not added. Ignoring vote.`
    );
    assert(
      mapVote(testChannel1, `1`, testMap1) ===
        `You cannot vote now. Ignoring vote.`
    );
    assert(stopGame(testChannel1) === "Can't stop the game now.");

    // Wait for async work to complete (looking for server + setting map)
    await sleep(MOCK_ASYNC_SLEEP_FOR * 3);

    // Game should now be cleared for testChannel1
    assert(store.getState().games[testChannel1] === undefined);

    // Check the stored JSON file (game state)
    const storedGame: Game = JSON.parse(
      fs.readFileSync(
        `${GAMES_PATH}/${orderRecentFiles(GAMES_PATH)[0].file}`,
        "utf-8"
      )
    );
    assert(storedGame.state === GameState.PlayersConnect);
    assert(Object.values(storedGame.players).length === 12);

    // Test invalid after game has been completed and another has not started yet
    assert(mapVote(testChannel1, `invalid`, testMap1) === NO_GAME_STARTED);
    assert.deepEqual(removePlayer(testChannel1, `1`), [NO_GAME_STARTED]);
    assert(
      readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) === NO_GAME_STARTED
    );
    assert(stopGame(testChannel1) === NO_GAME_STARTED);
    assert(getStatus(testChannel1) === NO_GAME_STARTED);
    assert.deepEqual(kickPlayer(testChannel1, `1`), [NO_GAME_STARTED]);
  };

  const testReadyTimeout = async () => {
    // Start a second game by adding a player to test ready up timeout
    assert.deepEqual(addPlayer(testChannel1, `1`), [
      STARTING_FROM_ADD,
      NEW_GAME_STARTED,
      `Added: <@1>`,
      getStatus(testChannel1),
    ]);

    assert(store.getState().games[testChannel1].state === GameState.AddRemove);

    // Add another 10 players ( total 11)
    for (let x = 1; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), [
        `Added: <@${x + 1}>`,
        getStatus(testChannel1),
      ]);
      await sleep(10); // Get a different timestamp for each player
    }

    // Check for 11 players
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 11
    );

    // Manually set the 11 players currently added to unready
    const readyUntilTimestamp = Date.now() - 1000; // 1 sec in the past
    for (let x = 0; x < 11; x++) {
      const game = store.getState().games[testChannel1];
      store.dispatch({
        type: READY_PLAYER,
        payload: {
          channelId: game.channelId,
          playerId: `${x + 1}`,
          readyUntil: readyUntilTimestamp,
        },
      });
    }

    // Add last player
    assert.deepEqual(addPlayer(testChannel1, `12`), [
      `Added: <@12>`,
      getStatus(testChannel1),
      `The game is full.`,
    ]);

    assert(store.getState().games[testChannel1].state === GameState.ReadyCheck);

    // Test invalid states when waiting for players to ready up
    assert(startGame(testChannel1) === GAME_ALREADY_STARTED);
    assert.deepEqual(addPlayer(testChannel1, `12`), [
      `Can't add <@12> right now. Ignoring.`,
    ]);
    assert(
      mapVote(testChannel1, `invalid`, testMap1),
      `Not in map voting phase. Ignoring vote.`
    );
    assert(stopGame(testChannel1), "Can't stop the game now.");

    // Readying up a player should work at this stage
    assert(
      readyPlayer(testChannel1, `12`, DEFAULT_READY_FOR).includes(
        `<@12> is ready for 10min (until `
      )
    );

    // Test removing player when waiting for players to ready up
    assert.deepEqual(removePlayer(testChannel1, `12`), [
      "Cancelling ready check.",
      "Removed: <@12>",
      getStatus(testChannel1),
    ]);

    assert(store.getState().games[testChannel1].state === GameState.AddRemove);
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 11
    );

    // Add a last player
    assert.deepEqual(addPlayer(testChannel1, `12`), [
      `Added: <@12>`,
      getStatus(testChannel1),
      `The game is full.`,
    ]);

    // Wait for ready up timeout
    await sleep(overrideTimeout + 100);

    // 11 out of the 12 players should have been removed (did not ready up)
    assert(store.getState().games[testChannel1].state === GameState.AddRemove);
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 1
    );
    assert(
      Object.values(store.getState().games[testChannel1].players)[0].id === "12"
    );

    // Add another 11 players to fill the game again
    for (let x = 0; x < 10; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), [
        `Added: <@${x + 1}>`,
        getStatus(testChannel1),
      ]);
      await sleep(10); // Get a different timestamp for each player
    }
    assert.deepEqual(addPlayer(testChannel1, `11`), [
      `Added: <@11>`,
      getStatus(testChannel1),
      "The game is full.",
    ]);

    // All players should be ready now and the map vote should now be happening
    assert(store.getState().games[testChannel1].state === GameState.MapVote);
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 12
    );
  };

  const testUltiduo = async () => {
    // Test a second channel with Ultiduo
    assert(
      setChannelGameMode(testChannel2, GameMode.Ultiduo) ===
        `Game mode set to ULTIDUO.`
    );
    assert(startGame(testChannel2) === NEW_GAME_STARTED);
    assert.deepEqual(addPlayer(testChannel2, `a`), [
      `Added: <@a>`,
      "Status (1/4): <@a>:ballot_box_with_check: ",
    ]);
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, `b`), [
      `Added: <@b>`,
      "Status (2/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: ",
    ]);
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, `c`), [
      `Added: <@c>`,
      "Status (3/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: <@c>:ballot_box_with_check: ",
    ]);
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, `d`), [
      `Added: <@d>`,
      "Status (4/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: <@c>:ballot_box_with_check: <@d>:ballot_box_with_check: ",
      "The game is full.",
    ]);
    assert(
      mapVote(testChannel2, `a`, "koth_ultiduo_r_b7") ===
        `You voted for koth_ultiduo_r_b7.`
    );
    assert(
      mapVote(testChannel2, `b`, "ultiduo_baloo_v2") ===
        "You voted for ultiduo_baloo_v2."
    );
    assert(
      mapVote(testChannel2, `c`, "ultiduo_baloo_v2") ===
        "You voted for ultiduo_baloo_v2."
    );
    assert(
      mapVote(testChannel2, `d`, "ultiduo_baloo_v2") ===
        "You voted for ultiduo_baloo_v2."
    );

    // Check the winning map and num players
    assert(
      store.getState().games[testChannel2].state === GameState.FindingServer
    );
    assert(store.getState().games[testChannel2].map === "ultiduo_baloo_v2");
    assert(
      Object.values(store.getState().games[testChannel2].players).length === 4
    );
  };

  const testUnreadyDuringReadyTimeout = async () => {
    // Test player becoming unready while readying up players.
    setChannelGameMode(testChannel3, GameMode.BBall);
    addPlayer(testChannel3, "1");
    addPlayer(testChannel3, "2");

    // Manually set player 2's readyUntil so they are not ready when the game fills
    store.dispatch({
      type: READY_PLAYER,
      payload: {
        channelId: testChannel3,
        playerId: "2",
        readyUntil: Date.now() - 100,
      },
    });

    // Add player 3
    addPlayer(testChannel3, "3");

    // Manually set player 3's readyUntil so it lies within the readyTimeout
    const readyUntil = Date.now() + overrideTimeout / 2;
    store.dispatch({
      type: READY_PLAYER,
      payload: { channelId: testChannel3, playerId: "3", readyUntil },
    });

    // Add last player to fill game
    addPlayer(testChannel3, "4");

    assert(store.getState().games[testChannel3].state === GameState.ReadyCheck);

    assert(
      readyUntil > (store.getState().games[testChannel3].readyCheckAt as number)
    );

    // Wait until after ready timeout
    await sleep(overrideTimeout + 100);

    assert(readyUntil < Date.now());

    assert(store.getState().games[testChannel3].state === GameState.AddRemove);

    // Players 1 and 4 should still be added
    assert(store.getState().games[testChannel3].players["1"] !== undefined);
    assert(store.getState().games[testChannel3].players["4"] !== undefined);

    // Player 2 should be removed
    assert(store.getState().games[testChannel3].players["2"] === undefined);

    // Player 3 should still be added even through they became unready during the ready check timeout.
    assert(store.getState().games[testChannel3].players["3"] !== undefined);
  };

  await testGame();
  await testReadyTimeout();
  await testUltiduo();
  await testUnreadyDuringReadyTimeout();
};
