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
// @ts-ignore
import Rcon from "rcon";
import { createStore } from "redux";

dotenv.config();

const client = new Discord.Client({ intents: [Intents.FLAGS.GUILDS] });

type Player = {
  id: string;
  queuedAt: number;
  readyUntil: number;
  mapVote: null | string;
};

enum GameState {
  AddRemove,
  ReadyCheck,
  MapVote,
  MapVoteComplete,
  FindingServer,
  SettingMap,
  PlayersConnect,
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
  socket: null | string;
  playersConnectAt: null | number;
};

type Games = { [channelId: string]: Game };

type Channel = {
  id: string;
  mode: GameMode;
};

type Channels = { [channelId: string]: Channel };

type RootState = { games: Games; channels: Channels };

const MAP_VOTE_PREFIX = "map-vote-";
const READY_BUTTON = "ready";
const VACATE_BUTTON_PREFIX = "vacate-";

const CHANNEL_NOT_SET_UP = `This channel has not been set up.`;
const NO_GAME_STARTED = `No game started. Use /start or /add to start one.`;

const SET_CHANNEL_GAME_MODE = "SET_CHANNEL_GAME_MODE";
const CREATE_GAME = "CREATE_GAME";
const REMOVE_GAME = "REMOVE_GAME";
const UPDATE_GAME = "UPDATE_GAME";
const ADD_PLAYER = "ADD_PLAYER";
const REMOVE_PLAYER = "REMOVE_PLAYER";
const REMOVE_PLAYERS = "REMOVE_PLAYERS";
const READY_PLAYER = "READY_PLAYER";
const PLAYER_MAP_VOTE = "PLAYER_MAP_VOTE";

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

const DEFAULT_READY_FOR = 1000 * 60 * 10; // 10 min
const MAX_READY_FOR = 1000 * 60 * 30; // 30 min
const MIN_READY_FOR = 1000 * 60 * 5;
let READY_TIMEOUT = 1000 * 45; // 45 seconds
let MAP_VOTE_TIMEOUT = 1000 * 45; // 45 seconds

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

// https://stackoverflow.com/a/55743632/2410292
const filterObjectByKeys = (object: any, keysToFilter: string[]) => {
  return Object.keys(object).reduce((accum, key) => {
    if (!keysToFilter.includes(key)) {
      return { ...accum, [key]: object[key] };
    } else {
      return accum;
    }
  }, {});
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

const getIsTestMode = () => process.env.TEST_MODE === "true";

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

const BASE_PATH = `${__dirname}/../data`;
const GAMES_PATH = `${BASE_PATH}/games`;
const CHANNELS_PATH = `${BASE_PATH}/channels`;

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

const NEW_GAME_STARTED = `New game started.`;
const GAME_ALREADY_STARTED = "A game has already been started.";

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
    socket: null,
    settingMapAt: null,
    playersConnectAt: null,
  };

  store.dispatch({ type: CREATE_GAME, payload: game });
  return NEW_GAME_STARTED;
};

const updateGame = (action: UpdateGame) => {
  store.dispatch(action);
};

const STOPPED_GAME = `Stopped game.`;

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

const STARTING_FROM_ADD = `No game started. Starting one now.`;

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

  const msgs = [`Added ${mentionPlayer(playerId)}.`, getStatus(channelId)];

  if (nextNumPlayers === totalPlayers) {
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyCheckAt: timestamp },
    });

    sendMsg(channelId, `The game is full.`);

    const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
    if (unreadyPlayerIds.length === 0) {
      startMapVote(channelId);
    } else {
      // Setup timeout if not all players ready up in time.
      const readyTimeout = setTimeout(() => {
        // If this runs, remove the unready players
        const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
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
          `Removed ${unreadyPlayerIds.length} unready player(s).\n${getStatus(
            channelId
          )}`,
          `${unreadyPlayerIds.map((p) => mentionPlayer(p)).join(" ")}`
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
        `${unreadyPlayerIds.length} player(s) are not ready. Waiting ${
          READY_TIMEOUT / 1000
        } seconds for them. Click the button (or use \`/ready\`) to ready up.`
      );

      if (channel?.isText()) {
        channel
          .send({
            embeds: [embed],
            components: [row],
            content: `${unreadyPlayerIds
              .map((p) => mentionPlayer(p))
              .join(" ")}`,
          })
          .then((embed) => {
            for (const unreadyPlayerId of unreadyPlayerIds) {
              sendDM(
                unreadyPlayerId,
                `Your PUG is full. Please ready up: ${embed.url}`
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
    `Removed players from this game as they are in another game that is about to start.\n${getStatus(
      channelId
    )}`,
    playerIds.map((p) => mentionPlayer(p)).join(" ")
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

    const game = getGame(channelId);

    const rows = [new MessageActionRow()];

    for (let x = 1; x <= maps.length; x++) {
      let lastRow = rows[rows.length - 1];
      if (lastRow.components.length === 5) {
        // Need a new row
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

    const channel = getDiscordChannel(channelId);

    const players = getPlayers(game);
    const embed = getEmbed(
      `Map vote starting now. Please click the map you want to play. Waiting ${
        MAP_VOTE_TIMEOUT / 1000
      } seconds for votes.`
    );

    if (channel?.isText()) {
      channel.send({
        embeds: [embed],
        components: rows,
        content: players.map((p) => mentionPlayer(p.id)).join(" "),
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

  msgs.push(`Removed ${mentionPlayer(playerId)}.`);
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

  let out = `Players (${numPlayers}/${totalPlayers}): `;
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
  const msgs = `${mentionPlayer(
    playerId
  )} is ready until ${readyUntilDate.toLocaleTimeString("en-ZA")}.\n${getStatus(
    channelId
  )}`;

  const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
  const game = getGame(channelId);
  const players = getPlayers(game);
  if (
    unreadyPlayerIds.length === 0 &&
    players.length === gameModeToNumPlayers(game.mode)
  ) {
    startMapVote(channelId);
  }
  return msgs;
};

const GAME_ID = "tf2";

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const splitSocket = (socket: string): { ip: string; port: number } => {
  const split = socket.split(":");
  const ip = split[0];
  const port = Number(split[1]);
  return { ip, port };
};

const getEnvSockets = (): string[] => {
  if (!process.env.TF2_SERVERS) {
    throw new Error("No sockets/tf2 servers set!");
  } else {
    return process.env.TF2_SERVERS.split(",");
  }
};

const getServerDetails = async (
  socket: string
): Promise<null | { numPlayers: number; map: string }> => {
  const { ip, port } = splitSocket(socket);

  try {
    const response = await Gamedig.query({
      type: GAME_ID,
      maxAttempts: 3,
      givenPortOnly: true,
      host: ip,
      port,
    });
    return { numPlayers: response.players.length, map: response.map };
  } catch (e) {
    console.log(`Error getting server response for ${socket}.`);
    return null;
  }
};

const findAvailableServer = async (): Promise<string | null> => {
  // Find a server with no players on it from set of available servers

  if (getIsTestMode()) {
    console.log("Not attempting to find a server as we are in test mode.");
    await sleep(500);
    return "no-server";
  }

  const sockets = getEnvSockets();

  if (sockets) {
    for (const socket of sockets) {
      const details = await getServerDetails(socket);
      if (details?.numPlayers === 0) {
        return socket;
      }
    }
  }
  return null;
};

const RCON_TIMEOUT = 5000;

const setMapOnServer = async (socket: string, map: string): Promise<string> => {
  // Send rcon command to change the map on the server
  if (getIsTestMode()) {
    console.log("Not setting map on server as we are in test mode.");
    await sleep(500);
    return "Not setting map on server as we are in test mode.";
  }

  const { ip, port } = splitSocket(socket);
  const password = process.env.RCON_PASSWORD;
  const conn = new Rcon(ip, port, password);

  const setMapPromise: Promise<string> = new Promise((resolve) => {
    const msgs: (null | string)[] = [];

    const resolveHandler = () => {
      const toResolve = msgs.filter((m) => m).join("\n");
      resolve(
        toResolve ? toResolve : "Looks like the map was changed successfully."
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
        const msg = str ? "Response:\n```" + str + "```" : null;
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

const vacate = async (socket: string): Promise<string> => {
  // Send rcon command to kick players from the server

  if (getIsTestMode()) {
    console.log("Not vacating as we are in test mode.");
    return "Not vacating as we are in test mode.";
  }

  const { ip, port } = splitSocket(socket);
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
        const msg = str ? "Response:\n```" + str + "```" : null;
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

const FIND_SERVER_ATTEMPTS = 60;
const FIND_SERVER_INTERVAL = 5000;

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

  let socket: null | string = null;
  for (let x = 0; x < FIND_SERVER_ATTEMPTS; x++) {
    socket = await findAvailableServer();
    if (socket) {
      break;
    } else {
      await sleep(FIND_SERVER_INTERVAL);
    }
  }

  if (socket) {
    updateGame({
      type: UPDATE_GAME,
      payload: {
        channelId,
        state: GameState.SettingMap,
        socket,
        settingMapAt: Date.now(),
      },
    });

    sendMsg(
      channelId,
      `:handshake: Found a server (${socket}). Attempting to set the map to **${winningMap}**...`
    );

    const setMapStatus = await setMapOnServer(socket, winningMap);

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
        `Your ${game.mode} PUG is ready. Please join the server at: steam://connect/${game.socket}/games`
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

const mapVote = (
  channelId: string,
  playerId: string,
  mapVote: string
): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return CHANNEL_NOT_SET_UP;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return NO_GAME_STARTED;
  }

  if (existingGame.state !== GameState.MapVote) {
    return `Not in map voting phase. Ignoring vote.`;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return `${mentionPlayer(playerId)} is not added. Ignoring vote.`;
  }

  store.dispatch({
    type: PLAYER_MAP_VOTE,
    payload: { channelId, playerId, mapVote },
  });

  // Notify users about player vote
  const msg = `You voted for ${mapVote}.`;

  const game = getGame(channelId);

  const numVotes = getPlayers(game).filter((p) => p.mapVote).length;
  if (numVotes === gameModeToNumPlayers(game.mode)) {
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

  return msg;
};

const isPlayerReady = (timestamp: number, playerReadyUntil: number) =>
  playerReadyUntil >= timestamp;

const sortPlayers = (a: Player, b: Player) =>
  a.queuedAt <= b.queuedAt ? -1 : 1;

const getPlayers = (game: Game) =>
  Object.values(game.players).sort(sortPlayers);

const getUnreadyPlayerIds = (channelId: string): string[] => {
  const now = Date.now();
  const game = getGame(channelId);
  const players = getPlayers(game);
  const unreadyPlayerIds = [];
  for (const player of players) {
    const isReady = isPlayerReady(now, player.readyUntil);
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

export const test = async () => {
  process.env.TEST_MODE = "true";

  // Manually set timeouts to low values
  READY_TIMEOUT = 1000 * 1; // 1 second
  MAP_VOTE_TIMEOUT = 1000 * 1; // 1 second

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
  assert(readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR) === NO_GAME_STARTED);
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
    `Added <@1>.`,
    `Players (1/12): <@1>:ballot_box_with_check: `,
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
    setChannelGameMode(testChannel1, GameMode.Test) === `Game mode set to TEST.`
  );
  assert(
    setChannelGameMode(testChannel1, GameMode.Sixes) ===
      `Game mode set to SIXES.`
  );

  // Start game
  assert(startGame(testChannel1) === NEW_GAME_STARTED);

  // Test invalid commands right after new game started
  assert(startGame(testChannel1) === GAME_ALREADY_STARTED);
  mapVote(testChannel1, `invalid`, testMap1);
  removePlayer(testChannel1, `1`);
  assert.deepEqual(kickPlayer(testChannel1, `1`), [
    `<@1> is not added. Ignoring.`,
  ]);

  // Ready player
  readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR);

  for (let x = 0; x < 11; x++) {
    addPlayer(testChannel1, `${x + 1}`);
  }

  // Try add player again
  assert.deepEqual(addPlayer(testChannel1, `1`), [
    `<@1> is already added. Ignoring.`,
  ]);

  for (let x = 0; x < 11; x++) {
    removePlayer(testChannel1, `${x + 1}`);
  }

  for (let x = 0; x < 12; x++) {
    addPlayer(testChannel1, `${x + 1}`);
  }

  const s = store.getState();
  const game = s.games[testChannel1];

  if (getPlayers(game).length !== 12) {
    console.error("Unexpected number of players");
    return;
  }
  if (game.state !== GameState.MapVote) {
    console.error("Unexpected game state (expected MapVote)");
    return;
  }

  startGame(testChannel1); // Should send error message
  addPlayer(testChannel1, `1`); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message
  readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR); // Should send error message
  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  stopGame(testChannel1); // Should send error message

  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  for (let x = 0; x < 12; x++) {
    mapVote(
      testChannel1,
      `${x + 1}`,
      x < 4 ? testMap1 : x < 8 ? testMap2 : testMap3
    );
  }

  // Check the winning map one of the three test maps
  const compareMapsTo = [testMap1, testMap2, testMap3] as string[];
  assert(store.getState().games[testChannel1].map !== null);
  assert(
    compareMapsTo.includes(store.getState().games[testChannel1].map as string)
  );

  // Prev game is still processing (looking for server, setting map etc)
  startGame(testChannel1); // Should send error message
  addPlayer(testChannel1, `1`); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message
  readyPlayer(testChannel1, `1`, DEFAULT_READY_FOR); // Should send error message
  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  stopGame(testChannel1); // Should send error message

  // Get past async work in looking for server, setting map etc
  setTimeout(() => {
    // Start a second game
    for (let x = 0; x < 11; x++) {
      addPlayer(testChannel1, `${x + 1}`);
    }

    // Manually set the 11 players currently added unready
    const s = store.getState();
    const game = s.games[testChannel1];
    const timestamp = Date.now() - 1000; // 1 sec in the past
    for (let x = 0; x < 11; x++) {
      store.dispatch({
        type: READY_PLAYER,
        payload: {
          channelId: game.channelId,
          playerId: `${x + 1}`,
          readyUntil: timestamp,
        },
      });
    }

    // Add last player
    addPlayer(testChannel1, `12`);

    startGame(testChannel1); // Should send error message
    addPlayer(testChannel1, `12`); // Should send error message
    mapVote(testChannel1, `invalid`, testMap1); // Should send error message
    stopGame(testChannel1); // Should send error message

    readyPlayer(testChannel1, `12`, DEFAULT_READY_FOR); // Should work

    removePlayer(testChannel1, `12`); // Should work - take back
    if (
      store.getState().games[testChannel1].state !== GameState.FindingServer
    ) {
      console.error("Unexpected game state (expected FindingServer)");
      return;
    }

    addPlayer(testChannel1, `12`);

    for (let x = 0; x < 11; x++) {
      readyPlayer(testChannel1, `${x + 1}`, DEFAULT_READY_FOR);
    }

    // Check working when players do not ready up in time
    setTimeout(() => {
      // Start a second game
      for (let x = 0; x < 11; x++) {
        addPlayer(testChannel1, `${x + 1}`);
      }

      // Manually set the 11 players currently added unready
      const s = store.getState();
      const game = s.games[testChannel1];
      const timestamp = Date.now() - 1000; // 1 sec in the past
      for (let x = 0; x < 11; x++) {
        store.dispatch({
          type: READY_PLAYER,
          payload: {
            channelId: game.channelId,
            playerId: `${x + 1}`,
            readyUntil: timestamp,
          },
        });
      }

      addPlayer(testChannel1, `12`);
    }, MAP_VOTE_TIMEOUT + 500);

    // Expect players to be removed and game returned to AddRemove state
  });

  // Test a second channel with Ultiduo
  console.log(setChannelGameMode(testChannel2, GameMode.Ultiduo));
  console.log(startGame(testChannel2));
  console.log(addPlayer(testChannel2, `a`));
  console.log(addPlayer(testChannel2, `b`));
  console.log(addPlayer(testChannel2, `c`));
  console.log(addPlayer(testChannel2, `d`));
  console.log(mapVote(testChannel2, `a`, "koth_ultiduo_r_b7"));
  console.log(mapVote(testChannel2, `b`, "ultiduo_baloo_v2"));
  console.log(mapVote(testChannel2, `c`, "ultiduo_baloo_v2"));
  console.log(mapVote(testChannel2, `d`, "ultiduo_baloo_v2"));

  // Check the winning map is ultiduo_baloo_v2
  assert(store.getState().games[testChannel2].map === "ultiduo_baloo_v2");

  // Currently looking for an available server

  console.log(setChannelGameMode(testChannel3, GameMode.BBall));
  console.log(startGame(testChannel3));
  console.log(addPlayer(testChannel3, `a`));
  console.log(addPlayer(testChannel3, `b`));
  console.log(addPlayer(testChannel3, `c`));
  console.log(addPlayer(testChannel3, `d`));
};

export enum Commands {
  Ping = "ping",
  Setup = "setup",
  Start = "start",
  Status = "status",
  Maps = "maps",
  Add = "add",
  Remove = "remove",
  Kick = "kick",
  Vacate = "vacate",
  Ready = "ready",
  MapVote = "vote-map",
  Stop = "stop",
}

const getEmbed = (msg: string) => new MessageEmbed().setDescription(msg);

const handleMultiResponse = (
  interaction: Discord.CommandInteraction<Discord.CacheType>,
  msgs: string[]
) => {
  const msg = msgs.join(`\n`);
  interaction.reply({ embeds: [getEmbed(msg)] });
};

const NO_PERMISSION_MSG = "You do not have permission to do this.";

const hasPermission = (
  permissions: string | Readonly<Discord.Permissions>,
  permission: Discord.PermissionResolvable
): boolean => {
  if (typeof permissions !== "string" && permissions.has(permission)) {
    return true;
  }
  return false;
};

export const run = () => {
  getEnvSockets(); // Sanity check TF2 servers set correctly in the .env file
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
    const playerPermissions = interaction.member.permissions;

    switch (commandName) {
      case Commands.Ping: {
        interaction.reply({ ephemeral: true, embeds: [getEmbed("Pong!")] });
        break;
      }
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
          const sockets = getEnvSockets();
          for (const socket of sockets) {
            const details = await getServerDetails(socket);
            row.addComponents(
              new MessageButton()
                .setCustomId(`${VACATE_BUTTON_PREFIX}${socket}`)
                .setLabel(
                  `Vacate ${socket} (No. connected: ${
                    details?.numPlayers ?? "unknown"
                  }. Map: ${details?.map ?? "unknown"})`
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
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const { customId, channelId, user } = interaction;
    const playerId = user.id;
    const playerPermissions = interaction.member.permissions;

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
        const socket = customId.split(VACATE_BUTTON_PREFIX)[1];
        const msg = await vacate(socket);
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
