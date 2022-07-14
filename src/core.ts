import { configureStore } from "@reduxjs/toolkit";
import { strict as assert } from "assert";
import { randomUUID } from "crypto";
import Discord, {
  Intents,
  MessageActionRow,
  MessageButton,
  MessageEditOptions,
  MessageEmbed,
  MessageOptions,
  Permissions,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import Gamedig from "gamedig";
import {
  filterObjectByKeys,
  getRandomElInArray,
  orderRecentFiles,
  sleep,
} from "./utils";

const Rcon: any = require("rcon");

dotenv.config();

// Data paths
const BASE_PATH = `${__dirname}/../data`;
const GAMES_PATH = `${BASE_PATH}/games`;
const CHANNELS_PATH = `${BASE_PATH}/channels`;

// Gamedig
const GAME_ID = "tf2";

// Timeout lengths
const DEFAULT_READY_FOR = 1000 * 60 * 5; // 5 min
const MAX_READY_FOR = 1000 * 60 * 30; // 30 min
const MIN_READY_FOR = 1000 * 60 * 0; // 0 min
let READY_TIMEOUT = 1000 * 60; // 60 seconds (value changed in testing code)
let MAP_VOTE_TIMEOUT = 1000 * 60; // 60 seconds (value changed in testing code)

const RCON_TIMEOUT = 5000;
const RCON_DISCONNECT_AFTER = 5000;
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
const GAME_ALREADY_STARTED = "A game has already been started.";
const STOPPED_GAME = `Stopped game.`;
const NO_PERMISSION_MSG = "You do not have permission to do this.";
const ALL_READY_MSG = `All players are ready.`;

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

const timeoutMap = new Map<string, NodeJS.Timeout>();
const msgMap = new Map<string, Discord.Message<boolean>>();

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
  Flip = "flip",
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
  readyTimeoutId: null | string; // UUID mapped to NodeJS timeout. Shouldn't store NodeJS Timeout in redux (non-serializable)
  readyMsgId: null | string; // To be edited with current unready players status
  mapVoteAt: null | number;
  mapVoteTimeoutId: null | string;
  winningMaps: null | string[]; // Set if there are multiple tied winning maps based on player votes
  maxVoteCount: null | number;
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

type Server = {
  socketAddress: string;
  name: string;
};

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
    game: Partial<Game>;
  };
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

type Msg = string;

const getIsTestMode = () => process.env.TEST_MODE === "true";

const getGameModeNumPlayers = (gameMode: GameMode): number => {
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
      const { channelId, game } = action.payload;

      return {
        ...state,
        games: {
          ...state.games,
          [channelId]: { ...state.games[channelId], ...game },
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

const store = configureStore({ reducer });

const getDiscordChannel = (channelId: string) =>
  client.channels.cache.get(channelId);

const sendMsg = async (
  channelId: string,
  embedText: string,
  mainText?: string
): Promise<Discord.Message<boolean> | null> => {
  if (getIsTestMode()) {
    console.log(channelId, embedText, mainText);
    return null;
  }
  const channel = getDiscordChannel(channelId);

  const msgObj: MessageOptions = { embeds: [embedMsg(embedText)] };
  if (mainText) {
    msgObj.content = mainText;
  }

  if (channel?.isText()) {
    return channel.send(msgObj);
  } else {
    console.error(`channel ${channelId} is not a text channel.`);
    return null;
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

const setGameMode = (channelId: string, mode: GameMode): Msg[] => {
  store.dispatch({
    type: SET_CHANNEL_GAME_MODE,
    payload: { channelId, mode },
  });
  saveChannelGameMode(channelId, mode);
  return [`Game mode set to ${mode}.`];
};

const getChannel = (channelId: string) => {
  const state = store.getState();
  return state.channels[channelId];
};

const getGame = (channelId: string) => {
  const state = store.getState();
  return state.games[channelId];
};

const getIsPlayerAdded = (channelId: string, playerId: string): boolean => {
  const game = getGame(channelId);
  return !!game.players[playerId];
};

const startGame = (channelId: string): Msg[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const isExisting = !!getGame(channelId);
  if (isExisting) {
    return [GAME_ALREADY_STARTED];
  }

  const channelType = channel.mode;

  const game: Game = {
    mode: channelType,
    channelId,
    state: GameState.AddRemove,
    startedAt: Date.now(),
    players: {},
    readyCheckAt: null,
    readyTimeoutId: null,
    readyMsgId: null,
    mapVoteAt: null,
    mapVoteTimeoutId: null,
    winningMaps: null,
    maxVoteCount: null,
    map: null,
    findingServerAt: null,
    socketAddress: null,
    settingMapAt: null,
    playersConnectAt: null,
  };

  store.dispatch({ type: CREATE_GAME, payload: game });
  return [NEW_GAME_STARTED];
};

const updateGame = (channelId: string, game: Partial<Game>) => {
  store.dispatch({ type: UPDATE_GAME, payload: { channelId, game } });
};

const stopGame = (channelId: string): Msg[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const game = getGame(channelId);
  if (!game) {
    return [NO_GAME_STARTED];
  }

  if (game.state !== GameState.AddRemove) {
    return ["Can't stop the game now."];
  }

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
  return [STOPPED_GAME];
};

const getGameModeMaps = (mode: GameMode): string[] => {
  const maps = JSON.parse(fs.readFileSync(`${BASE_PATH}/maps.json`, "utf-8"));
  return maps[mode];
};

enum AllReadyStatus {
  OneMap,
  AllVoted,
  MapVote,
}

const handleVoteComplete = (channelId: string) => {
  const { winningMaps, maxVoteCount } = getWinningMapsFromVotes(channelId);

  const nextGameState = {
    winningMaps,
    maxVoteCount,
    state: GameState.FindingServer,
  };

  let map = null;
  if (maxVoteCount === 0 || winningMaps.length > 1) {
    // If no votes recieved or there is more than one map that tied for the win
    map = getRandomElInArray(winningMaps);
  } else {
    // If there is only one map with the most votes (won the vote)
    map = winningMaps[0];
  }

  updateGame(channelId, { ...nextGameState, map });
};

const handleAllReady = (channelId: string): AllReadyStatus => {
  // All players are ready
  removePlayersFromOtherGames(channelId);

  const existingGame = getGame(channelId);
  const timeoutId = existingGame.readyTimeoutId;
  if (timeoutId) {
    const timeout = timeoutMap.get(timeoutId);
    if (timeout) {
      clearTimeout(timeout);
      timeoutMap.delete(timeoutId);
    }
    updateGame(channelId, { readyTimeoutId: null });
  }

  const maps = getGameModeMaps(existingGame.mode);

  // Players can vote while the game is filling up (and during the ready check)
  // Potentially all players have voted before the voting timeout
  const game = getGame(channelId);
  const players = getPlayers(game);
  const numVotes = players.filter((p) => p.mapVote).length;

  if (maps.length === 1) {
    // Special case for only one map (eg. BBall)
    updateGame(channelId, { map: maps[0], state: GameState.FindingServer });
    return AllReadyStatus.OneMap;
  } else if (numVotes === getGameModeNumPlayers(game.mode)) {
    // Special case that all players have already voted before the map vote timeout
    handleVoteComplete(channelId);
    return AllReadyStatus.AllVoted;
  } else {
    const mapVoteTimeoutId = randomUUID();
    const mapVoteTimeout = setTimeout(() => {
      timeoutMap.delete(mapVoteTimeoutId);
      updateGame(channelId, { mapVoteTimeoutId: null });
      handleVoteComplete(channelId);
      handleSendMapVoteResult(channelId);
    }, MAP_VOTE_TIMEOUT);
    timeoutMap.set(mapVoteTimeoutId, mapVoteTimeout);

    updateGame(channelId, {
      mapVoteAt: Date.now(),
      mapVoteTimeoutId,
      state: GameState.MapVote,
    });
    return AllReadyStatus.MapVote;
  }
};

enum AfterAdd {
  Rejected,
  NotFull,
  FullAndNotReady,
  FullAllReadyOneMap,
  FullAllReadyMapVote,
}

const addPlayer = (
  channelId: string,
  playerId: string
): { msgs: Msg[]; status: AfterAdd } => {
  const channel = getChannel(channelId);
  if (!channel) {
    return { msgs: [CHANNEL_NOT_SET_UP], status: AfterAdd.Rejected };
  }

  const msgs = [];
  let game = getGame(channelId);
  // If a game has not been started, start one now
  if (!game) {
    msgs.push(...startGame(channelId));
    game = getGame(channelId);
  }

  if (game.state !== GameState.AddRemove) {
    return {
      msgs: [`Can't add ${mentionPlayer(playerId)} right now. Ignoring.`],
      status: AfterAdd.Rejected,
    };
  }

  const isAdded = getIsPlayerAdded(channelId, playerId);
  if (isAdded) {
    return {
      msgs: [`${mentionPlayer(playerId)} is already added. Ignoring.`],
      status: AfterAdd.Rejected,
    };
  }

  const prevNumPlayers = getPlayers(game).length;
  const nextNumPlayers = prevNumPlayers + 1;
  const totalPlayers = getGameModeNumPlayers(game.mode);

  // Sanity check
  if (nextNumPlayers > totalPlayers) {
    console.error(
      `Bug: More than total num players added to game in channelId: ${channelId}.`
    );
    return {
      msgs: [`The game is full. Ignoring.`],
      status: AfterAdd.Rejected,
    };
  }

  const timestamp = Date.now();
  const player: Player = {
    id: playerId,
    queuedAt: timestamp,
    // readyUntil:
    //   game.mode === GameMode.Test
    //     ? timestamp - 1
    //     : timestamp + DEFAULT_READY_FOR, // Force a ready from the one when using the test game mode
    readyUntil: timestamp + DEFAULT_READY_FOR,
    mapVote: null,
  };

  store.dispatch({
    type: ADD_PLAYER,
    payload: { channelId, player },
  });

  msgs.push(`Added: ${mentionPlayer(playerId)}`, ...getStatus(channelId));

  if (nextNumPlayers === totalPlayers) {
    // The game is now full
    updateGame(channelId, { readyCheckAt: timestamp });
    msgs.push(`The game is full.`);

    const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
    if (unreadyPlayerIds.length === 0) {
      // All players are ready
      const allReadyStatus = handleAllReady(channelId);

      switch (allReadyStatus) {
        case AllReadyStatus.OneMap: {
          return { msgs, status: AfterAdd.FullAllReadyOneMap };
        }
        case AllReadyStatus.MapVote:
        default: {
          return { msgs, status: AfterAdd.FullAllReadyMapVote };
        }
      }
    } else {
      // At least one player is unready
      const readyTimeoutId = randomUUID();
      const readyTimeout = setTimeout(async () => {
        // If this runs (will be cancelled if all players ready up), remove the unready players.
        const game = getGame(channelId);
        const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
        store.dispatch({
          type: REMOVE_PLAYERS,
          payload: { channelId, playerIds: unreadyPlayerIds },
        });
        timeoutMap.delete(readyTimeoutId);
        if (game.readyMsgId) {
          msgMap.delete(game.readyMsgId);
        }
        updateGame(channelId, {
          state: GameState.AddRemove,
          readyTimeoutId: null,
          readyMsgId: null,
        });

        await sendMsg(
          channelId,
          `:slight_frown: Removed ${
            unreadyPlayerIds.length
          } unready player(s) as they did not ready up in time.\n${getStatus(
            channelId
          )}`,
          `Removed: ${unreadyPlayerIds.map((p) => mentionPlayer(p)).join(" ")}`
        );
      }, READY_TIMEOUT);
      timeoutMap.set(readyTimeoutId, readyTimeout);

      updateGame(channelId, { state: GameState.ReadyCheck, readyTimeoutId });

      return { msgs, status: AfterAdd.FullAndNotReady };
    }
  } else {
    return { msgs, status: AfterAdd.NotFull };
  }
};

function getUnreadyMsg(channelId: string, _: "new"): MessageOptions;
function getUnreadyMsg(channelId: string, _: "edit"): MessageEditOptions;
function getUnreadyMsg(channelId: string, _: "new" | "edit") {
  const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
  const numUnready = unreadyPlayerIds.length;

  if (numUnready === 0) {
    const embed = embedMsg(`Everyone is ready!`);
    return {
      embeds: [embed],
      components: [],
      content: null,
    };
  } else {
    const row = new MessageActionRow().addComponents(
      new MessageButton()
        .setCustomId(READY_BUTTON)
        .setLabel("Ready up!")
        .setStyle("SUCCESS")
    );

    const embed = embedMsg(
      `:hourglass: ${
        unreadyPlayerIds.length
      } player(s) are not ready. Waiting ${
        READY_TIMEOUT / 1000
      } seconds for them. Click the button (or use \`/ready\`) to ready up.`
    );

    return {
      embeds: [embed],
      components: [row],
      content: `Unready: ${unreadyPlayerIds
        .map((p) => mentionPlayer(p))
        .join(" ")}`,
    };
  }
}

const handleFindServer = async (channelId: string) => {
  updateGame(channelId, {
    findingServerAt: Date.now(),
  });

  await sendMsg(
    channelId,
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
    updateGame(channelId, {
      state: GameState.SettingMap,
      socketAddress: server.socketAddress,
      settingMapAt: Date.now(),
    });

    const winningMap = getGame(channelId).map as string;

    await sendMsg(
      channelId,
      `:handshake: Found server: ${server.name} (\`${server.socketAddress}\`). Attempting to set the map to **${winningMap}**...`
    );

    const setMapStatus = await setMapOnServer(server.socketAddress, winningMap);

    await sendMsg(channelId, setMapStatus);

    updateGame(channelId, {
      state: GameState.PlayersConnect,
      playersConnectAt: Date.now(),
    });

    const game = getGame(channelId);
    const playerIds = getPlayers(game).map((p) => p.id);

    // Don't await these sends (send at same time)
    sendMsg(
      channelId,
      `:fireworks: **Good to go. Join the server now. Check your DMs for a link to join.**`,
      `Join now: ${playerIds.map((p) => mentionPlayer(p)).join(" ")}`
    );

    for (const playerId of playerIds) {
      sendDM(
        playerId,
        `Your ${game.mode} PUG is ready. Please join the server at: steam://connect/${game.socketAddress}/games`
      );
    }
  } else {
    const game = getGame(channelId);
    const playerIds = getPlayers(game).map((p) => p.id);
    await sendMsg(
      channelId,
      `:exclamation: **Could not find an available server. If one is available, please connect now.**`,
      `${playerIds.map((p) => mentionPlayer(p)).join(" ")}`
    );
  }

  // Store game as JSON for debugging and historic data access for potentially map selection/recommendations (TODO)
  const game = getGame(channelId);
  const path = `${GAMES_PATH}/${Date.now()}.json`;

  const stringified = JSON.stringify(game, null, 2);
  fs.writeFileSync(path, stringified, "utf-8");

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
};

const handleAfterAddFullAndUnready = async (channelId: string) => {
  // Ask unready players to ready
  const channel = getDiscordChannel(channelId);
  const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
  const unreadyMsg = getUnreadyMsg(channelId, "new");

  if (channel?.isText()) {
    const gameMode = getGame(channelId).mode;
    const readyMsg = await channel.send(unreadyMsg);

    const readyMsgId = randomUUID();
    msgMap.set(readyMsgId, readyMsg);

    updateGame(channelId, { readyMsgId }); // Store the ready message so it can be updated if need be
    for (const unreadyPlayerId of unreadyPlayerIds) {
      sendDM(
        unreadyPlayerId,
        `Please ready up for you ${gameMode} PUG: ${readyMsg.url}`
      );
    }
  }
};

const handleAllReadyOneMap = async (channelId: string) => {
  await sendMsg(channelId, ALL_READY_MSG);
  const game = getGame(channelId);
  await sendMsg(
    channelId,
    `:map: **Playing ${game.map} as it's the only available map.**`
  );
  handleFindServer(channelId);
};

const handleSendMapVoteResult = async (channelId: string) => {
  const game = getGame(channelId);
  if (game.maxVoteCount === 0) {
    // No votes were recieved. The map has already been randomly selected.
    await sendMsg(
      channelId,
      `No votes received.\n\n:map: **${game.map} was randomly selected as the winner.**`
    );
  } else if (game.winningMaps && game.winningMaps.length > 1) {
    // Multiple maps tied for the win. The map has already been randomly selected.
    await sendMsg(
      channelId,
      `${game.winningMaps.join(", ")} tied with ${
        game.maxVoteCount
      } votes each.\n\n:map: **${
        game.map
      } was randomly selected as the winner.**`
    );
  } else {
    // Only one map won the vote
    await sendMsg(
      channelId,
      `:map: **${game.map}** won with ${game.maxVoteCount} vote(s).`
    );
  }
  handleFindServer(channelId);
};

const handleAllReadyAllVoted = async (channelId: string) => {
  await sendMsg(channelId, ALL_READY_MSG);
  handleSendMapVoteResult(channelId);
};

const sendMapVoteButtons = (channelId: string) => {
  const rows = getMapVoteButtons(channelId);

  const game = getGame(channelId);
  const players = getPlayers(game);
  const embed = embedMsg(
    `:ballot_box: Map vote starting now. Click the map you want to play (click another to change your vote). Waiting ${
      MAP_VOTE_TIMEOUT / 1000
    } seconds for votes.`
  );

  const channel = getDiscordChannel(channelId);
  if (channel?.isText()) {
    channel.send({
      embeds: [embed],
      components: rows,
      content: `Vote now: ${players.map((p) => mentionPlayer(p.id)).join(" ")}`,
    });
  }
};

const handleAllReadyMapVote = async (channelId: string) => {
  await sendMsg(channelId, ALL_READY_MSG);
  sendMapVoteButtons(channelId);
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

const removePlayer = (channelId: string, playerId: string): Msg[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return [NO_GAME_STARTED];
  }

  const isAdded = getIsPlayerAdded(channelId, playerId);
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
  updateGame(channelId, { state: GameState.AddRemove });

  const msgs = [];

  const timeoutId = existingGame.readyTimeoutId;
  if (timeoutId) {
    const timeout = timeoutMap.get(timeoutId);
    if (timeout) {
      clearTimeout(timeout);
      timeoutMap.delete(timeoutId);
    }
    updateGame(channelId, { readyTimeoutId: null });
    msgs.push(`Cancelling ready check.`);
  }

  msgs.push(`Removed: ${mentionPlayer(playerId)}`);
  msgs.push(...getStatus(channelId));
  return msgs;
};

const kickPlayer = (channelId: string, playerId: string) => {
  return removePlayer(channelId, playerId);
};

const getStatus = (channelId: string): Msg[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return [NO_GAME_STARTED];
  }

  const game = getGame(channelId);
  const players = getPlayers(game);
  const numPlayers = players.length;
  const totalPlayers = getGameModeNumPlayers(game.mode);

  let msg = `Status (${numPlayers}/${totalPlayers}): `;
  if (players.length === 0) {
    msg += "Empty";
  } else {
    const now = Date.now();
    for (const player of players) {
      msg += `${mentionPlayer(player.id)}`;
      const isReady = getIsPlayerReady(now, player.readyUntil);
      if (isReady) {
        msg += `:ballot_box_with_check: `;
      } else {
        msg += `:zzz: `;
      }
    }
  }
  return [msg];
};

enum AfterReady {
  Rejected,
  NotReady,
  ReadyOneMap,
  ReadyAllVoted,
  ReadyMapVote,
}

const readyPlayer = (
  channelId: string,
  playerId: string,
  time: number
): { msgs: Msg[]; status: AfterReady } => {
  // Ready the player up and then check if all players are ready
  const channel = getChannel(channelId);
  if (!channel) {
    return { msgs: [CHANNEL_NOT_SET_UP], status: AfterReady.Rejected };
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return { msgs: [NO_GAME_STARTED], status: AfterReady.Rejected };
  }

  if (
    ![GameState.AddRemove, GameState.ReadyCheck].includes(existingGame.state)
  ) {
    return {
      msgs: [`Can't ready ${mentionPlayer(playerId)} right now. Ignoring.`],
      status: AfterReady.Rejected,
    };
  }

  const isAdded = getIsPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return {
      msgs: [`${mentionPlayer(playerId)} is not added. Ignoring.`],
      status: AfterReady.Rejected,
    };
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

  const msgs = [
    `${mentionPlayer(playerId)} is ready for ${Math.round(
      normalizedTime / 1000 / 60
    )}min (until ${readyUntilDate.toLocaleTimeString("en-ZA")}).`,
  ];

  // Edit/update the ready up message to show the current unready players
  if (game.state === GameState.ReadyCheck && game.readyMsgId) {
    const unreadyMsg = getUnreadyMsg(channelId, "edit");
    const readyMsg = msgMap.get(game.readyMsgId);
    if (readyMsg) {
      readyMsg.edit(unreadyMsg);
    }
  }

  // Check if this ready up means all players are ready
  if (game.state === GameState.ReadyCheck) {
    // If the game is full
    const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
    if (unreadyPlayerIds.length === 0) {
      // All players are ready
      if (game.readyMsgId) {
        msgMap.delete(game.readyMsgId);
        updateGame(channelId, { readyMsgId: null });
      }

      const allReadyStatus = handleAllReady(channelId);

      switch (allReadyStatus) {
        case AllReadyStatus.OneMap: {
          return { msgs, status: AfterReady.ReadyOneMap };
        }
        case AllReadyStatus.AllVoted: {
          return { msgs, status: AfterReady.ReadyAllVoted };
        }
        case AllReadyStatus.MapVote: {
          return { msgs, status: AfterReady.ReadyMapVote };
        }
      }
    }
  }
  return { msgs, status: AfterReady.NotReady };
};

const handleReadyStatus = (channelId: string, status: AfterReady) => {
  switch (status) {
    case AfterReady.ReadyOneMap: {
      handleAllReadyOneMap(channelId);
      break;
    }
    case AfterReady.ReadyAllVoted: {
      handleAllReadyAllVoted(channelId);
      break;
    }
    case AfterReady.ReadyMapVote: {
      handleAllReadyMapVote(channelId);
      break;
    }
  }
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
        setTimeout(() => {
          conn.disconnect();
        }, RCON_DISCONNECT_AFTER);
      })
      .on("response", (str: string) => {
        const msg = str
          ? `Set map response (${socketAddress}):` + "\n```\n" + str + "```"
          : null;
        console.log(msg);
        msgs.push(msg);
        if (msgs.length === 2) {
          // Auth and response from kick command
          resolveHandler();
        }
      })
      .on("error", (err: string) => {
        const msg =
          `Set map error (${socketAddress}):` +
          "\n```\n" +
          `${err ? err : "No error message."}` +
          "```";
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

const vacate = async (socketAddress: string): Promise<Msg[]> => {
  // Send rcon command to kick players from the server

  if (getIsTestMode()) {
    console.log("Not vacating as we are in test mode.");
    await sleep(MOCK_ASYNC_SLEEP_FOR);
    return ["Not vacating as we are in test mode."];
  }

  const { ip, port } = splitSocketAddress(socketAddress);
  const password = process.env.RCON_PASSWORD;
  const conn = new Rcon(ip, port, password);

  const vacatePromise: Promise<Msg[]> = new Promise((resolve) => {
    const msgs: (null | string)[] = [];

    const resolveHandler = () => {
      const toResolve = msgs.filter((m) => m).join("\n");
      resolve(
        toResolve
          ? [toResolve]
          : [
              `Vacate response (\`${socketAddress}\`):\nLooks like no players were kicked as no players were connected.`,
            ]
      );
    };

    conn
      .on("auth", () => {
        console.log("Authenticated");
        console.log("Sending command: kickall");
        conn.send("kickall");
        setTimeout(() => {
          conn.disconnect();
        }, RCON_DISCONNECT_AFTER);
      })
      .on("response", (str: string) => {
        const msg = str
          ? `Vacate response (${socketAddress}):` + "\n```\n" + str + "```"
          : null;
        console.log(msg);
        msgs.push(msg);
        if (msgs.length === 2) {
          // Auth and response from kick command
          resolveHandler();
        }
      })
      .on("error", (err: string) => {
        const msg =
          `Vacate error (${socketAddress}):` +
          "\n```\n" +
          `${err ? err : "No error message"}` +
          "```";
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

  const timeoutPromise: Promise<Msg[]> = new Promise((resolve) => {
    sleep(RCON_TIMEOUT).then(() => {
      resolve(["Error: Timed out."]);
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

// Returns randomly selected status
const getWinningMapsFromVotes = (
  channelId: string
): { winningMaps: string[]; maxVoteCount: number } => {
  const voteCounts = getMapVoteCounts(channelId);
  const maxVoteCount = Math.max(...Object.values(voteCounts));
  const winningMaps = Object.entries(voteCounts)
    .filter(([_, val]) => val === maxVoteCount)
    .map(([key, _]) => key);
  return { winningMaps, maxVoteCount };
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

  const isAdded = getIsPlayerAdded(channelId, playerId);
  if (!isAdded) {
    return { isAllowed: false, msg: `You are not added. Ignoring vote.` };
  }

  if (![GameState.AddRemove, GameState.MapVote].includes(existingGame.state)) {
    return { isAllowed: false, msg: `You cannot vote now. Ignoring vote.` };
  }

  return { isAllowed: true };
};

enum AfterVote {
  Rejected,
  NotAllVoted,
  AllVoted,
}

const mapVote = (
  channelId: string,
  playerId: string,
  mapVote: string
): { msgs: Msg[]; status: AfterVote } => {
  const allowedStatus = getCanVote(channelId, playerId);

  if (!allowedStatus.isAllowed) {
    return { msgs: [allowedStatus.msg], status: AfterVote.Rejected };
  }

  store.dispatch({
    type: PLAYER_MAP_VOTE,
    payload: { channelId, playerId, mapVote },
  });

  const msgs = [`You voted for ${mapVote}.`];

  const game = getGame(channelId);
  const numVotes = getPlayers(game).filter((p) => p.mapVote).length;
  if (
    game.state === GameState.MapVote &&
    numVotes === getGameModeNumPlayers(game.mode)
  ) {
    // All players voted in the alloted time
    const timeoutId = game.mapVoteTimeoutId;
    if (timeoutId) {
      const timeout = timeoutMap.get(timeoutId);
      if (timeout) {
        clearTimeout(timeout);
        timeoutMap.delete(timeoutId);
      }
      updateGame(channelId, { mapVoteTimeoutId: null });
    }
    handleVoteComplete(channelId);
    return { msgs, status: AfterVote.AllVoted };
  }
  return { msgs, status: AfterVote.NotAllVoted };
};

const getIsPlayerReady = (unreadyAfter: number, playerReadyUntil: number) =>
  playerReadyUntil >= unreadyAfter;

const sortPlayers = (a: Player, b: Player) =>
  a.queuedAt <= b.queuedAt ? -1 : 1;

const getPlayers = (game: Game): Player[] =>
  Object.values(game.players).sort(sortPlayers);

const getUnreadyPlayerIds = (channelId: string): string[] => {
  const game = getGame(channelId);
  const unreadyAfter = game.readyCheckAt as number;
  const players = getPlayers(game);
  const unreadyPlayerIds = [];
  for (const player of players) {
    const isReady = getIsPlayerReady(unreadyAfter, player.readyUntil);
    if (!isReady) {
      unreadyPlayerIds.push(player.id);
    }
  }
  return unreadyPlayerIds;
};

const getMaps = (channelId: string): Msg[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [CHANNEL_NOT_SET_UP];
  }

  const maps = getGameModeMaps(channel.mode);

  return [`Available maps for ${channel.mode}:\n${maps.join("\n")}`];
};

const embedMsg = (msg: string) => new MessageEmbed().setDescription(msg);

const getHasPermission = (
  permissions: string | Readonly<Discord.Permissions> | undefined,
  permission: Discord.PermissionResolvable
): boolean => {
  if (typeof permissions !== "string" && permissions?.has(permission)) {
    return true;
  }
  return false;
};

const joinMsgs = (msgs: Msg[]) => msgs.join(`\n`);

const handleCommandReply = async (
  interaction: Discord.CommandInteraction<Discord.CacheType>,
  msgs: Msg[],
  ephemeral = false,
  components: Discord.MessageActionRow[] | undefined = undefined
) => {
  const msg = joinMsgs(msgs);
  const reply: Discord.InteractionReplyOptions = {
    embeds: [embedMsg(msg)],
    ephemeral,
  };
  if (components) {
    reply.components = components;
  }
  try {
    await interaction.reply(reply);
  } catch (e) {
    console.error(reply);
    throw e;
  }
};

const handleEditCommandReply = async (
  interaction: Discord.CommandInteraction<Discord.CacheType>,
  msgs: Msg[],
  components: Discord.MessageActionRow[] | undefined = undefined
) => {
  const msg = joinMsgs(msgs);
  const reply: Discord.InteractionReplyOptions = {
    embeds: [embedMsg(msg)],
  };
  if (components) {
    reply.components = components;
  }
  await interaction.editReply(reply);
};

const handleButtonReply = async (
  interaction: Discord.ButtonInteraction<Discord.CacheType>,
  msgs: Msg[],
  ephemeral = false
) => {
  const msg = joinMsgs(msgs);
  await interaction.reply({ embeds: [embedMsg(msg)], ephemeral });
};

const handleEditButtonReply = async (
  interaction: Discord.ButtonInteraction<Discord.CacheType>,
  msgs: Msg[]
) => {
  const msg = joinMsgs(msgs);
  await interaction.editReply({ embeds: [embedMsg(msg)] });
};

export const run = () => {
  assert(getEnvSocketAddresses().length > 0); // Check TF2 servers set correctly in the .env file
  // Check maps file is correct
  for (const mode of Object.values(GameMode)) {
    assert(getGameModeMaps(mode).length > 0);
  }
  setUpDataDirs();
  loadChannels();

  client.login(process.env.DISCORD_BOT_TOKEN);

  client.once("ready", () => {
    console.log("Ready!");
  });

  // Handle slash command actions
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
          getHasPermission(playerPermissions, Permissions.FLAGS.MANAGE_CHANNELS)
        ) {
          const mode = interaction.options.getString("mode") as GameMode;
          const msgs = setGameMode(channelId, mode);
          await handleCommandReply(interaction, msgs);
        } else {
          await handleCommandReply(
            interaction,
            [`${NO_PERMISSION_MSG} You need the MANAGE_CHANNELS permission.`],
            true
          );
        }
        break;
      }
      case Commands.Start: {
        const msgs = startGame(channelId);
        await handleCommandReply(interaction, msgs);
        break;
      }
      case Commands.Status: {
        const msgs = getStatus(channelId);
        await handleCommandReply(interaction, msgs);
        break;
      }
      case Commands.Maps: {
        const msgs = getMaps(channelId);
        await handleCommandReply(interaction, msgs);
        break;
      }
      case Commands.Stop: {
        if (
          getHasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)
        ) {
          const msgs = stopGame(channelId);
          await handleCommandReply(interaction, msgs);
        } else {
          await handleCommandReply(
            interaction,
            [`${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`],
            true
          );
        }
        break;
      }
      case Commands.Add: {
        const { msgs, status } = addPlayer(channelId, playerId);
        await handleCommandReply(interaction, msgs);
        switch (status) {
          case AfterAdd.FullAndNotReady: {
            handleAfterAddFullAndUnready(channelId);
            break;
          }
          case AfterAdd.FullAllReadyOneMap: {
            handleAllReadyOneMap(channelId);
            break;
          }
          case AfterAdd.FullAllReadyMapVote: {
            handleAllReadyMapVote(channelId);
            break;
          }
        }
        break;
      }
      case Commands.Remove: {
        const msgs = removePlayer(channelId, playerId);
        await handleCommandReply(interaction, msgs);
        break;
      }
      case Commands.Kick: {
        if (
          getHasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)
        ) {
          const targetPlayer = interaction.options.getUser("user");
          if (targetPlayer) {
            const msgs = kickPlayer(channelId, targetPlayer.id);
            await handleCommandReply(interaction, msgs);
          } else {
            await handleCommandReply(interaction, [
              `Could not find player to kick.`,
            ]);
          }
        } else {
          await handleCommandReply(
            interaction,
            [`${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`],
            true
          );
        }
        break;
      }
      case Commands.Ready: {
        const minutesIn = interaction.options.getNumber("minutes");
        const readyFor =
          minutesIn !== null ? minutesIn * 1000 * 60 : DEFAULT_READY_FOR;
        const { msgs, status } = readyPlayer(channelId, playerId, readyFor);
        await handleCommandReply(interaction, msgs);
        handleReadyStatus(channelId, status);
        break;
      }
      case Commands.Vacate: {
        if (
          getHasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)
        ) {
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
                  `${details?.name ?? "unknown"} (${socketAddress}). Players: ${
                    details?.numPlayers ?? "unknown"
                  }. Map: ${details?.map ?? "unknown"}.`
                )
                .setStyle("DANGER")
            );
          }

          const components = [row];
          await handleEditCommandReply(
            interaction,
            [
              "Please click the server you want to vacate. Make sure there is not a game currently happening on it!",
            ],
            components
          );
        } else {
          await handleCommandReply(
            interaction,
            [`${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`],
            true
          );
        }
        break;
      }
      case Commands.MapVote: {
        // Send map vote buttons privately to the user.
        const canVoteStatus = getCanVote(channelId, playerId);

        if (!canVoteStatus.isAllowed) {
          await handleCommandReply(interaction, [canVoteStatus.msg], true);
          return;
        }

        const components = getMapVoteButtons(channelId);
        await handleCommandReply(
          interaction,
          [
            "Please click the map you want to play. Click another to change your vote.",
          ],
          true,
          components
        );

        break;
      }
      case Commands.Flip: {
        const result = Math.floor(Math.random() * 2);
        const resultStr = result === 0 ? "Heads!" : "Tails!";
        await handleCommandReply(interaction, [resultStr]);
      }
    }
  });

  // Handle button actions
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const { customId, channelId, user } = interaction;
    const playerId = user.id;
    const playerPermissions = interaction.member?.permissions;

    if (customId.includes(MAP_VOTE_PREFIX)) {
      const map = customId.split(MAP_VOTE_PREFIX)[1];
      const { msgs, status } = mapVote(channelId, playerId, map);
      await handleButtonReply(interaction, msgs, true);

      switch (status) {
        case AfterVote.AllVoted: {
          handleSendMapVoteResult(channelId);
          break;
        }
      }
    } else if (customId === READY_BUTTON) {
      const { msgs, status } = readyPlayer(
        channelId,
        playerId,
        DEFAULT_READY_FOR
      );
      await handleButtonReply(interaction, msgs, true);
      handleReadyStatus(channelId, status);
    } else if (customId.includes(VACATE_BUTTON_PREFIX)) {
      if (getHasPermission(playerPermissions, Permissions.FLAGS.MANAGE_ROLES)) {
        await interaction.deferReply();
        const socketAddress = customId.split(VACATE_BUTTON_PREFIX)[1];
        const msgs = await vacate(socketAddress);
        await handleEditButtonReply(interaction, msgs);
      } else {
        await handleButtonReply(
          interaction,
          [`${NO_PERMISSION_MSG} You need the MANAGE_ROLES permission.`],
          true
        );
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
    // console.log(s);
  });

  const testChannel1 = "test-channel-1";
  const testChannel2 = "test-channel-2";
  const testChannel3 = "test-channel-3";
  const testMap1 = "cp_snakewater_final1";
  const testMap2 = "cp_granary_pro_rc8";
  const testMap3 = "cp_reckoner_rc6";

  const testGame = async () => {
    // Test invalid commands when channel is not set up
    assert.deepEqual(startGame(testChannel1), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.Rejected,
      msgs: [CHANNEL_NOT_SET_UP],
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: [CHANNEL_NOT_SET_UP],
      status: AfterReady.Rejected,
    });
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: [CHANNEL_NOT_SET_UP],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(getStatus(testChannel1), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(getMaps(testChannel1), [CHANNEL_NOT_SET_UP]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [CHANNEL_NOT_SET_UP]);

    // Setup channel
    assert.deepEqual(setGameMode(testChannel1, GameMode.Sixes), [
      "Game mode set to SIXES.",
    ]);

    // Test invalid commands when channel set up but no game started
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: [NO_GAME_STARTED],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [NO_GAME_STARTED]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: [NO_GAME_STARTED],
      status: AfterReady.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), [NO_GAME_STARTED]);
    assert.deepEqual(getStatus(testChannel1), [NO_GAME_STARTED]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [NO_GAME_STARTED]);

    assert.deepEqual(getMaps(testChannel1), [
      "Available maps for SIXES:\ncp_granary_pro_rc8\ncp_gullywash_f7\ncp_metalworks_f4\ncp_process_f11\ncp_prolands_rc2p\ncp_reckoner_rc6\ncp_snakewater_final1\ncp_sunshine\nkoth_clearcut_b15d\nkoth_product_final",
    ]);

    // Start a game with /add
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.NotFull,
      msgs: [
        NEW_GAME_STARTED,
        "Added: <@1>",
        "Status (1/12): <@1>:ballot_box_with_check: ",
      ],
    });

    // Stop the game
    assert.deepEqual(stopGame(testChannel1), [STOPPED_GAME]);

    // Change channel type
    assert.deepEqual(setGameMode(testChannel1, GameMode.BBall), [
      "Game mode set to BBALL.",
    ]);
    assert.deepEqual(setGameMode(testChannel1, GameMode.Ultiduo), [
      "Game mode set to ULTIDUO.",
    ]);
    assert.deepEqual(setGameMode(testChannel1, GameMode.Highlander), [
      "Game mode set to HIGHLANDER.",
    ]);
    assert.deepEqual(setGameMode(testChannel1, GameMode.Test), [
      "Game mode set to TEST.",
    ]);
    assert.deepEqual(setGameMode(testChannel1, GameMode.Sixes), [
      "Game mode set to SIXES.",
    ]);

    // Start game
    assert.deepEqual(startGame(testChannel1), [NEW_GAME_STARTED]);

    // Empty game status
    assert.deepEqual(getStatus(testChannel1), ["Status (0/12): Empty"]);

    // Test invalid commands right after new game started
    assert.deepEqual(startGame(testChannel1), [GAME_ALREADY_STARTED]);
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: ["You are not added. Ignoring vote."],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [
      "<@1> is not added. Ignoring.",
    ]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [
      "<@1> is not added. Ignoring.",
    ]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: ["<@1> is not added. Ignoring."],
      status: AfterReady.Rejected,
    });

    // Add 11 Status (not full)
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), {
        status: AfterAdd.NotFull,
        msgs: [`Added: <@${x + 1}>`, ...getStatus(testChannel1)],
      });
      await sleep(10); // Force a different timestamp for each player to check status
    }

    // Check status
    assert.deepEqual(getStatus(testChannel1), [
      "Status (11/12): <@1>:ballot_box_with_check: <@2>:ballot_box_with_check: <@3>:ballot_box_with_check: <@4>:ballot_box_with_check: <@5>:ballot_box_with_check: <@6>:ballot_box_with_check: <@7>:ballot_box_with_check: <@8>:ballot_box_with_check: <@9>:ballot_box_with_check: <@10>:ballot_box_with_check: <@11>:ballot_box_with_check: ",
    ]);

    // Ready player 11
    assert(
      readyPlayer(testChannel1, "11", DEFAULT_READY_FOR).msgs[0].includes(
        "<@11> is ready for 5min (until "
      )
    );

    // Test ready player that is not added
    assert(
      readyPlayer(testChannel1, "invalid", DEFAULT_READY_FOR).msgs[0].includes(
        "<@invalid> is not added. Ignoring."
      )
    );

    // Try add player again
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.Rejected,
      msgs: ["<@1> is already added. Ignoring."],
    });

    // Remove all 11 players
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(removePlayer(testChannel1, `${x + 1}`), [
        `Removed: <@${x + 1}>`,
        ...getStatus(testChannel1),
      ]);
    }

    // Add all players to fill game
    for (let x = 0; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), {
        status: AfterAdd.NotFull,
        msgs: [`Added: <@${x + 1}>`, ...getStatus(testChannel1)],
      });
    }

    assert.deepEqual(addPlayer(testChannel1, "12"), {
      status: AfterAdd.FullAllReadyMapVote,
      msgs: ["Added: <@12>", ...getStatus(testChannel1), "The game is full."],
    });

    // Check correct num players added
    assert.deepEqual(
      getPlayers(store.getState().games[testChannel1]).length,
      12
    );
    // Check in map vote state
    assert.deepEqual(
      store.getState().games[testChannel1].state,
      GameState.MapVote
    );

    // Test invalid actions when in map vote state
    assert.deepEqual(startGame(testChannel1), [GAME_ALREADY_STARTED]);
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.Rejected,
      msgs: ["Can't add <@1> right now. Ignoring."],
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [
      "Can't remove <@1> right now. Ignoring.",
    ]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [
      "Can't remove <@1> right now. Ignoring.",
    ]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: ["Can't ready <@1> right now. Ignoring."],
      status: AfterReady.Rejected,
    });
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: ["You are not added. Ignoring vote."],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), ["Can't stop the game now."]);

    // Players vote for one of three maps (even distribution)
    for (let x = 0; x < 11; x++) {
      const map = x < 4 ? testMap1 : x < 8 ? testMap2 : testMap3;
      assert.deepEqual(mapVote(testChannel1, `${x + 1}`, map), {
        msgs: [`You voted for ${map}.`],
        status: AfterVote.NotAllVoted,
      });
    }
    assert.deepEqual(mapVote(testChannel1, "12", testMap3), {
      msgs: [`You voted for ${testMap3}.`],
      status: AfterVote.AllVoted,
    });

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
    handleSendMapVoteResult(testChannel1);

    // Check invalid commands when looking for server and setting map
    assert.deepEqual(startGame(testChannel1), [GAME_ALREADY_STARTED]);
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.Rejected,
      msgs: ["Can't add <@1> right now. Ignoring."],
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [
      "Can't remove <@1> right now. Ignoring.",
    ]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [
      "Can't remove <@1> right now. Ignoring.",
    ]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: ["Can't ready <@1> right now. Ignoring."],
      status: AfterReady.Rejected,
    });
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: ["You are not added. Ignoring vote."],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(mapVote(testChannel1, "1", testMap1), {
      msgs: ["You cannot vote now. Ignoring vote."],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), ["Can't stop the game now."]);

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
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: [NO_GAME_STARTED],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(removePlayer(testChannel1, "1"), [NO_GAME_STARTED]);
    assert.deepEqual(readyPlayer(testChannel1, "1", DEFAULT_READY_FOR), {
      msgs: [NO_GAME_STARTED],
      status: AfterReady.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), [NO_GAME_STARTED]);
    assert.deepEqual(getStatus(testChannel1), [NO_GAME_STARTED]);
    assert.deepEqual(kickPlayer(testChannel1, "1"), [NO_GAME_STARTED]);
  };

  const testReadyTimeout = async () => {
    // Start a second game by adding a player to test ready up timeout
    assert.deepEqual(addPlayer(testChannel1, "1"), {
      status: AfterAdd.NotFull,
      msgs: [NEW_GAME_STARTED, "Added: <@1>", ...getStatus(testChannel1)],
    });

    assert(store.getState().games[testChannel1].state === GameState.AddRemove);

    // Add another 10 players (total 11)
    for (let x = 1; x < 11; x++) {
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), {
        status: AfterAdd.NotFull,
        msgs: [`Added: <@${x + 1}>`, ...getStatus(testChannel1)],
      });
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
    assert.deepEqual(addPlayer(testChannel1, "12"), {
      status: AfterAdd.FullAndNotReady,
      msgs: ["Added: <@12>", ...getStatus(testChannel1), "The game is full."],
    });

    assert(store.getState().games[testChannel1].state === GameState.ReadyCheck);

    // Test invalid states when waiting for players to ready up
    assert.deepEqual(startGame(testChannel1), [GAME_ALREADY_STARTED]);
    assert.deepEqual(addPlayer(testChannel1, "12"), {
      status: AfterAdd.Rejected,
      msgs: ["Can't add <@12> right now. Ignoring."],
    });
    assert.deepEqual(removePlayer(testChannel1, "invalid"), [
      "<@invalid> is not added. Ignoring.",
    ]);
    assert.deepEqual(mapVote(testChannel1, "invalid", testMap1), {
      msgs: ["You are not added. Ignoring vote."],
      status: AfterVote.Rejected,
    });
    assert.deepEqual(stopGame(testChannel1), ["Can't stop the game now."]);

    // Readying up a player should work at this stage
    assert(
      readyPlayer(testChannel1, "12", DEFAULT_READY_FOR).msgs[0].includes(
        "<@12> is ready for 5min (until "
      )
    );

    // Test removing player when waiting for players to ready up
    assert.deepEqual(removePlayer(testChannel1, "12"), [
      "Cancelling ready check.",
      "Removed: <@12>",
      ...getStatus(testChannel1),
    ]);

    assert(store.getState().games[testChannel1].state === GameState.AddRemove);
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 11
    );

    // Add a last player
    assert.deepEqual(addPlayer(testChannel1, "12"), {
      status: AfterAdd.FullAndNotReady,
      msgs: ["Added: <@12>", ...getStatus(testChannel1), "The game is full."],
    });

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
      assert.deepEqual(addPlayer(testChannel1, `${x + 1}`), {
        status: AfterAdd.NotFull,
        msgs: [`Added: <@${x + 1}>`, ...getStatus(testChannel1)],
      });
    }
    assert.deepEqual(addPlayer(testChannel1, "11"), {
      status: AfterAdd.FullAllReadyMapVote,
      msgs: ["Added: <@11>", ...getStatus(testChannel1), "The game is full."],
    });

    // All players should be ready now and the map vote should now be happening
    assert(store.getState().games[testChannel1].state === GameState.MapVote);
    assert(
      Object.values(store.getState().games[testChannel1].players).length === 12
    );

    // Wait for find server, change map etc
    await sleep(MOCK_ASYNC_SLEEP_FOR * 3);
  };

  const testUltiduo = async () => {
    // Test a second channel with Ultiduo
    assert.deepEqual(setGameMode(testChannel2, GameMode.Ultiduo), [
      "Game mode set to ULTIDUO.",
    ]);
    assert.deepEqual(startGame(testChannel2), [NEW_GAME_STARTED]);
    assert.deepEqual(addPlayer(testChannel2, "a"), {
      status: AfterAdd.NotFull,
      msgs: ["Added: <@a>", "Status (1/4): <@a>:ballot_box_with_check: "],
    });
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, "b"), {
      status: AfterAdd.NotFull,
      msgs: [
        "Added: <@b>",
        "Status (2/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: ",
      ],
    });
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, "c"), {
      status: AfterAdd.NotFull,
      msgs: [
        "Added: <@c>",
        "Status (3/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: <@c>:ballot_box_with_check: ",
      ],
    });
    await sleep(10);
    assert.deepEqual(addPlayer(testChannel2, "d"), {
      status: AfterAdd.FullAllReadyMapVote,
      msgs: [
        "Added: <@d>",
        "Status (4/4): <@a>:ballot_box_with_check: <@b>:ballot_box_with_check: <@c>:ballot_box_with_check: <@d>:ballot_box_with_check: ",
        "The game is full.",
      ],
    });

    assert.deepEqual(mapVote(testChannel2, "a", "koth_ultiduo_r_b7"), {
      msgs: ["You voted for koth_ultiduo_r_b7."],
      status: AfterVote.NotAllVoted,
    });
    assert.deepEqual(mapVote(testChannel2, "b", "ultiduo_baloo_v2"), {
      msgs: ["You voted for ultiduo_baloo_v2."],
      status: AfterVote.NotAllVoted,
    });
    assert.deepEqual(mapVote(testChannel2, "c", "ultiduo_baloo_v2"), {
      msgs: ["You voted for ultiduo_baloo_v2."],
      status: AfterVote.NotAllVoted,
    });
    assert.deepEqual(mapVote(testChannel2, "d", "ultiduo_baloo_v2"), {
      msgs: ["You voted for ultiduo_baloo_v2."],
      status: AfterVote.AllVoted,
    });

    // Check the winning map and num players
    assert.deepEqual(
      store.getState().games[testChannel2].state,
      GameState.FindingServer
    );
    assert.deepEqual(
      store.getState().games[testChannel2].map,
      "ultiduo_baloo_v2"
    );
    assert.deepEqual(
      Object.values(store.getState().games[testChannel2].players).length,
      4
    );

    handleSendMapVoteResult(testChannel2);
  };

  const testUnreadyDuringReadyTimeout = async () => {
    // Test player becoming unready while readying up players.
    setGameMode(testChannel3, GameMode.BBall);
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

  const testMapVoteTimeout = async () => {
    // Test correct map being selected when at least one player does not vote for a map
    // Test player becoming unready while readying up players.
    // Add all players to enter map vote stage
    setGameMode(testChannel1, GameMode.Sixes);

    for (let x = 0; x < 12; x++) {
      addPlayer(testChannel1, `${x + 1}`);
    }

    assert.deepEqual(
      store.getState().games[testChannel1].state,
      GameState.MapVote
    );

    assert.deepEqual(mapVote(testChannel1, "2", testMap1), {
      msgs: [`You voted for ${testMap1}.`],
      status: AfterVote.NotAllVoted,
    });

    // Wait for map vote timeout
    await sleep(MAP_VOTE_TIMEOUT);

    // Wait for find server set map etc
    await sleep(MOCK_ASYNC_SLEEP_FOR * 3);

    // Check the stored JSON file (game state)
    const storedGame: Game = JSON.parse(
      fs.readFileSync(
        `${GAMES_PATH}/${orderRecentFiles(GAMES_PATH)[0].file}`,
        "utf-8"
      )
    );

    assert.deepEqual(storedGame.maxVoteCount, 1);
    assert.deepEqual(storedGame.winningMaps, [testMap1]);
    assert.deepEqual(storedGame.map, testMap1);
  };

  await testGame();
  await testReadyTimeout();
  await testUltiduo();
  await testUnreadyDuringReadyTimeout();
  await testMapVoteTimeout();
};
