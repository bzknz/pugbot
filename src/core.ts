import Discord, {
  Intents,
  MessageActionRow,
  MessageButton,
  MessageEmbed,
  MessageOptions,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
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
  readyTimeout: null | number;
  mapVoteAt: null | number;
  mapVoteTimeout: null | number;
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
const READY_TIMEOUT = 1000 * 30; // 30 seconds
const MAP_VOTE_TIMEOUT = 1000 * 15; // 15 seconds

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

const getDiscordChannel = (channelId: string) =>
  client.channels.cache.get(channelId);

const sendMsg = async (
  channelId: string,
  embedText: string,
  mainText?: string
) => {
  // Send message on Discord
  console.log(`${channelId}: ${embedText}`);
  const channel = getDiscordChannel(channelId);

  const msgObj: MessageOptions = { embeds: [getEmbed(embedText)] };
  if (mainText) {
    msgObj.content = mainText;
  }

  if (channel?.isText()) {
    channel.send(msgObj);
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

const startGame = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return `This channel has not been set up.`;
  }

  const isExisting = !!getGame(channelId);
  if (isExisting) {
    return "A game has already been started.";
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
  return `New game started.`;
};

const updateGame = (action: UpdateGame) => {
  store.dispatch(action);
};

const stopGame = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return `This channel has not been set up.`;
  }

  const game = getGame(channelId);
  if (!game) {
    return "No game started so nothing to stop.";
  }

  if (game.state !== GameState.AddRemove) {
    return "Can't stop the game now.";
  }

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
  return `Stopped game.`;
};

const getGameModeMaps = (mode: GameMode) => {
  const maps = JSON.parse(fs.readFileSync(`${BASE_PATH}/maps.json`, "utf-8"));
  return maps[mode];
};

const addPlayer = (channelId: string, playerId: string): string[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [`This channel has not been set up.`];
  }

  const game = getGame(channelId);
  if (!game) {
    const msgs = [`No game started. Starting one now.`];
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
          `Removed (not ready): ${unreadyPlayerIds
            .map((p) => mentionPlayer(p))
            .join(" ")}`
        );
      }, READY_TIMEOUT);

      updateGame({
        type: UPDATE_GAME,
        payload: {
          channelId,
          state: GameState.ReadyCheck,
          readyTimeout: +readyTimeout,
        },
      });

      // Ask unready players to ready
      sendMsg(
        channelId,
        `Some players are not ready: ${unreadyPlayerIds
          .map((p) => mentionPlayer(p))
          .join(" ")}. Waiting ${
          READY_TIMEOUT / 1000
        } seconds for them to ready.`
      );
    }
  }
  return msgs;
};

const startMapVote = (channelId: string) => {
  // All players are now ready - start map vote
  const existingGame = getGame(channelId);
  if (existingGame.readyTimeout) {
    clearTimeout(existingGame.readyTimeout);
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyTimeout: null },
    });
  }

  const mapVoteTimeout = setTimeout(() => {
    const game = getGame(channelId);
    const players = getPlayers(game);
    const numVotes = players.filter((p) => p.mapVote).length;
    sendMsg(channelId, `${numVotes}/${players.length} players voted.`);
    mapVoteComplete(channelId);
  }, MAP_VOTE_TIMEOUT);

  updateGame({
    type: UPDATE_GAME,
    payload: {
      channelId,
      state: GameState.MapVote,
      mapVoteAt: Date.now(),
      mapVoteTimeout: +mapVoteTimeout,
    },
  });

  sendMsg(channelId, `All players are ready.`);

  const game = getGame(channelId);
  const maps = getGameModeMaps(game.mode);

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

  const embed = getEmbed(
    `Map vote starting now. Please click the map you want to play.`
  );

  if (channel?.isText()) {
    channel.send({ embeds: [embed], components: rows });
  }
};

const removePlayer = (channelId: string, playerId: string): string[] => {
  const channel = getChannel(channelId);
  if (!channel) {
    return [`This channel has not been set up.`];
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return [`No game started. Can't remove ${mentionPlayer(playerId)}.`];
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

const getStatus = (channelId: string): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return `This channel has not been set up.`;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return `No game started. Can't get status.`;
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
      out += `:thumbsup: `;
    } else {
      out += `:zzz: `;
    }
  }
  return out;
};

const readyPlayer = (
  channelId: string,
  playerId: string,
  time = READY_TIMEOUT
): string => {
  // Ready the player up and then check if all players are ready
  const channel = getChannel(channelId);
  if (!channel) {
    return `This channel has not been set up.`;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return `No game started. Can't ready ${mentionPlayer(playerId)}.`;
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
  store.dispatch({
    type: READY_PLAYER,
    payload: { channelId, playerId, readyUntil: now + normalizedTime },
  });

  const msgs = `${mentionPlayer(playerId)} is ready.`;

  const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
  if (unreadyPlayerIds.length === 0) {
    startMapVote(channelId);
  }
  return msgs;
};

const findServer = async (): Promise<string> => {
  // TODO: Find a server with no players on it from ser of available servers
  return "TODO";
};

const setMapOnServer = async (socket: string, map: string) => {
  // TODO: Send rcon command to change the map on the server
};

const kickPlayersFromServer = (socket: string) => {
  // TODO: Send rcon command to kick players from the server
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
  const voteCounts = getMapVoteCounts(channelId);

  const msgs = [];
  const maxVoteCount = Math.max(...Object.values(voteCounts));
  const withMaxVotes = Object.entries(voteCounts)
    .filter(([_, val]) => val === maxVoteCount)
    .map(([key, _]) => key);
  let winningMap = withMaxVotes[0];
  if (withMaxVotes.length > 1) {
    // Pick a random map from the winners
    msgs.push(
      `${withMaxVotes.join(", ")} tied with ${maxVoteCount} votes each.`
    );
    const randIndex = Math.round(Math.random() * (withMaxVotes.length - 1));
    winningMap = withMaxVotes[randIndex];
    msgs.push(`**${winningMap}** was randomly selected as the winner.`);
  } else {
    msgs.push(`**${winningMap}** won with ${maxVoteCount} votes.`);
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

  msgs.push(`Attempting to find an available server (no players connected)...`);

  sendMsg(channelId, msgs.join("\n"));

  const socket = await findServer();
  // TODO: Timeout on finding a server (failure)

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
    `Found a server: ${socket}. Attempting to set the map to ${winningMap}...`
  );

  await setMapOnServer(socket, winningMap);
  // TODO: Timeout on finding setting the map on the server

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
  sendMsg(
    channelId,
    `:fireworks: **Good to go. Join the server now. Check your DMs for a link to join.**`,
    `${playerIds.map((p) => mentionPlayer(p)).join(" ")}`
  );

  // Store game as JSON for debugging and historic data access for potentially map selection/recommendations (TODO)
  const path = `${GAMES_PATH}/${Date.now()}.json`;
  fs.writeFileSync(path, JSON.stringify(game, null, 2), "utf-8");

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
};

const mapVote = (
  channelId: string,
  playerId: string,
  mapVote: string
): string => {
  const channel = getChannel(channelId);
  if (!channel) {
    return `This channel has not been set up.`;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    return `No game started. Ignoring vote.`;
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
  const msg = `${mentionPlayer(playerId)} voted for ${mapVote}.`;

  const game = getGame(channelId);

  const numVotes = getPlayers(game).filter((p) => p.mapVote).length;
  if (numVotes === gameModeToNumPlayers(game.mode)) {
    if (game.mapVoteTimeout) {
      clearTimeout(game.mapVoteTimeout as number);
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

export const test = () => {
  store.subscribe(() => {
    const s = store.getState();
    // console.log(JSON.stringify(s) + "\n");
  });

  const testChannel1 = "test-channel-1";
  const testChannel2 = "test-channel-2";
  const testMap1 = "cp_snakewater_final1";
  const testMap2 = "cp_granary_pro_rc8";
  const testMap3 = "cp_reckoner_rc6";

  startGame(testChannel1); // Should send error message
  addPlayer(testChannel1, `1`); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message
  readyPlayer(testChannel1, `1`); // Should send error message
  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  stopGame(testChannel1); // Should send error message

  setChannelGameMode(testChannel1, GameMode.Sixes);

  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message
  readyPlayer(testChannel1, `1`); // Should send error message
  stopGame(testChannel1); // Should send error message

  addPlayer(testChannel1, `1`); // Should start game
  stopGame(testChannel1); // Should work

  // Change channel type
  setChannelGameMode(testChannel1, GameMode.BBall); // Should work
  setChannelGameMode(testChannel1, GameMode.Sixes); // Should work

  stopGame(testChannel1); // Should send error message

  startGame(testChannel1);

  startGame(testChannel1); // Should send error message
  readyPlayer(testChannel1, `1`); // Should send error message
  mapVote(testChannel1, `invalid`, testMap1); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message

  for (let x = 0; x < 11; x++) {
    addPlayer(testChannel1, `${x + 1}`);
  }
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
  readyPlayer(testChannel1, `1`); // Should send error message
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

  // Prev game is still processing (looking for server, setting map etc)
  startGame(testChannel1); // Should send error message
  addPlayer(testChannel1, `1`); // Should send error message
  removePlayer(testChannel1, `1`); // Should send error message
  readyPlayer(testChannel1, `1`); // Should send error message
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

    readyPlayer(testChannel1, `12`); // Should work

    removePlayer(testChannel1, `12`); // Should work - take back
    if (store.getState().games[testChannel1].state !== GameState.AddRemove) {
      console.error("Unexpected game state (expected AddRemove)");
      return;
    }

    addPlayer(testChannel1, `12`);

    for (let x = 0; x < 11; x++) {
      readyPlayer(testChannel1, `${x + 1}`);
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
  setChannelGameMode(testChannel2, GameMode.Ultiduo);
  startGame(testChannel2);
  addPlayer(testChannel2, `a`);
  addPlayer(testChannel2, `b`);
  addPlayer(testChannel2, `c`);
  addPlayer(testChannel2, `d`);
  mapVote(testChannel2, `a`, "koth_ultiduo_r_b7");
  mapVote(testChannel2, `b`, "koth_ultiduo_r_b7");
  mapVote(testChannel2, `c`, "koth_ultiduo_r_b7");
  mapVote(testChannel2, `d`, "koth_ultiduo_r_b7");
};

export enum Commands {
  Ping = "ping",
  Setup = "setup",
  Start = "start",
  Status = "status",
  Add = "add",
  Remove = "remove",
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

export const run = () => {
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

    switch (commandName) {
      case Commands.Ping: {
        interaction.reply({ ephemeral: true, embeds: [getEmbed("Pong!")] });
        break;
      }
      case Commands.Setup: {
        const mode = interaction.options.getString("mode") as GameMode;
        const msg = setChannelGameMode(channelId, mode);
        interaction.reply({ embeds: [getEmbed(msg)] });
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
      case Commands.Stop: {
        const msg = stopGame(channelId);
        interaction.reply({ embeds: [getEmbed(msg)] });
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
      case Commands.Ready: {
        const msg = readyPlayer(channelId, playerId);
        interaction.reply({ embeds: [getEmbed(msg)] });
        break;
      }
    }
  });

  client.on("interactionCreate", (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const { customId, channelId, user } = interaction;
    const playerId = user.id;

    if (customId.includes(MAP_VOTE_PREFIX)) {
      const map = customId.split(MAP_VOTE_PREFIX)[1];
      const msg = mapVote(channelId, playerId, map);
      interaction.reply({ ephemeral: true, embeds: [getEmbed(msg)] });
    }
  });
};
