import Discord, { Intents } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import { createStore } from "redux";

dotenv.config();

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

enum GameMode {
  BBall = "BBALL",
  Highlander = "HIGHLANDER",
  Sixes = "SIXES",
  Ultiduo = "ULTIDUO",
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

const sendMsg = (channelId: string, msg: string) => {
  console.log(`${channelId}: ${msg}`);
  // TODO: Send message on Discord
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

const setChannelGameMode = (channelId: string, mode: GameMode) => {
  store.dispatch({
    type: SET_CHANNEL_GAME_MODE,
    payload: { channelId, mode },
  });
  saveChannelGameMode(channelId, mode);
  sendMsg(channelId, `Game mode set to ${mode}.`);
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

const startGame = (channelId: string) => {
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const isExisting = !!getGame(channelId);
  if (isExisting) {
    sendMsg(channelId, "A game has already been started.");
    return;
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
  sendMsg(channelId, `Game started.`);
};

const updateGame = (action: UpdateGame) => {
  store.dispatch(action);
};

const stopGame = (channelId: string) => {
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const game = getGame(channelId);
  if (!game) {
    sendMsg(channelId, "No game started so nothing to stop.");
    return;
  }

  if (game.state !== GameState.AddRemove) {
    sendMsg(channelId, "Can't stop the game now.");
    return;
  }

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
  sendMsg(channelId, `Stopped game.`);
};

const getGameModeMaps = (mode: GameMode) => {
  const maps = JSON.parse(fs.readFileSync(`${BASE_PATH}/maps.json`, "utf-8"));
  return maps[mode];
};

const addPlayer = (channelId: string, playerId: string) => {
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const game = getGame(channelId);
  if (!game) {
    sendMsg(channelId, `No game started. Starting one now.`);
    startGame(channelId);
    addPlayer(channelId, playerId);
    return;
  }

  if (game.state !== GameState.AddRemove) {
    sendMsg(channelId, `Can't add ${playerId} right now. Ignoring.`);
    return;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (isAdded) {
    sendMsg(channelId, `${playerId} is already added. Ignoring.`);
    return;
  }

  const prevNumPlayers = getPlayers(game).length;
  const nextNumPlayers = prevNumPlayers + 1;
  const totalPlayers = gameModeToNumPlayers(game.mode);

  // Sanity check
  if (nextNumPlayers > totalPlayers) {
    console.error(
      `Bug: More than total num players added to game in channelId: ${channelId}.`
    );
    sendMsg(channelId, `Bug: More than total num players added to game`);
    return;
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

  sendMsg(channelId, `Added ${playerId} (${nextNumPlayers}/${totalPlayers})`);

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
          `Removed (not ready): ${unreadyPlayerIds.join(", ")}`
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
        `Some players are not ready: ${unreadyPlayerIds.join(", ")}. Waiting ${
          READY_TIMEOUT / 1000
        } seconds for them to ready.`
      );
    }
  }
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

  let msg = `Map vote starting now. Please send just the number of the map you want to play.\n\n`;

  for (let x = 1; x <= maps.length; x++) {
    msg += `${x}. ${maps[x - 1]}\n`;
  }
  sendMsg(channelId, msg);
};

const removePlayer = (channelId: string, playerId: string) => {
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    sendMsg(channelId, `No game started. Can't remove ${playerId}.`);
    return;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    sendMsg(channelId, `${playerId} is not added. Ignoring.`);
    return;
  }

  // Check for expected game state
  if (
    ![GameState.AddRemove, GameState.ReadyCheck].includes(existingGame.state)
  ) {
    sendMsg(channelId, `Can't remove ${playerId} right now. Ignoring.`);
    return;
  }

  store.dispatch({ type: REMOVE_PLAYER, payload: { channelId, playerId } });
  updateGame({
    type: UPDATE_GAME,
    payload: { channelId, state: GameState.AddRemove },
  });

  if (existingGame.readyTimeout) {
    clearTimeout(existingGame.readyTimeout);
    updateGame({
      type: UPDATE_GAME,
      payload: { channelId, readyTimeout: null },
    });
    sendMsg(channelId, `Cancelling ready check.`);
  }

  const game = getGame(channelId);
  const numPlayers = getPlayers(game).length;
  const totalPlayers = gameModeToNumPlayers(game.mode);
  sendMsg(channelId, `${playerId} removed (${numPlayers}/${totalPlayers})`);
};

const readyPlayer = (
  channelId: string,
  playerId: string,
  time = READY_TIMEOUT
) => {
  // Ready the player up and then check if all players are ready
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    sendMsg(channelId, `No game started. Can't ready ${playerId}.`);
    return;
  }

  if (
    ![GameState.AddRemove, GameState.ReadyCheck].includes(existingGame.state)
  ) {
    sendMsg(channelId, `Can't ready ${playerId} right now. Ignoring.`);
    return;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    sendMsg(channelId, `${playerId} is not added. Ignoring.`);
    return;
  }

  const now = Date.now();
  const normalizedTime = Math.max(Math.min(time, MAX_READY_FOR), MIN_READY_FOR);
  store.dispatch({
    type: READY_PLAYER,
    payload: { channelId, playerId, readyUntil: now + normalizedTime },
  });

  sendMsg(channelId, `${playerId} is ready.`);

  const game = getGame(channelId);
  const unreadyPlayerIds = getUnreadyPlayerIds(channelId);
  if (unreadyPlayerIds.length === 0) {
    startMapVote(channelId);
  }
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

  const maxVoteCount = Math.max(...Object.values(voteCounts));
  const withMaxVotes = Object.entries(voteCounts)
    .filter(([_, val]) => val === maxVoteCount)
    .map(([key, _]) => key);
  let winningMap = withMaxVotes[0];
  if (withMaxVotes.length > 1) {
    // Pick a random map from the winners
    sendMsg(
      channelId,
      `${withMaxVotes.join(", ")} tied with ${maxVoteCount} votes each.`
    );
    const randIndex = Math.round(Math.random() * (withMaxVotes.length - 1));
    winningMap = withMaxVotes[randIndex];
    sendMsg(channelId, `${winningMap} was randomly selected as the winner.`);
  } else {
    sendMsg(channelId, `${winningMap} won with ${maxVoteCount} votes.`);
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

  sendMsg(
    channelId,
    `Attempting to find an available server (no players connected)...`
  );

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
    `Ready to go. Join the server now ${playerIds.join(", ")}`
  );

  // Store game as JSON for debugging and historic data access for potentially map selection/recommendations (TODO)
  const path = `${GAMES_PATH}/${Date.now()}.json`;
  fs.writeFileSync(path, JSON.stringify(game, null, 2), "utf-8");

  store.dispatch({ type: REMOVE_GAME, payload: channelId });
};

const mapVote = (channelId: string, playerId: string, mapVote: string) => {
  const channel = getChannel(channelId);
  if (!channel) {
    sendMsg(channelId, `This channel has not been set up.`);
    return;
  }

  const existingGame = getGame(channelId);
  if (!existingGame) {
    sendMsg(channelId, `No game started. Ignoring vote.`);
    return;
  }

  if (existingGame.state !== GameState.MapVote) {
    sendMsg(channelId, `Not in map voting phase. Ignoring vote.`);
    return;
  }

  const isAdded = checkPlayerAdded(channelId, playerId);
  if (!isAdded) {
    sendMsg(channelId, `${playerId} is not added. Ignoring vote.`);
    return;
  }

  store.dispatch({
    type: PLAYER_MAP_VOTE,
    payload: { channelId, playerId, mapVote },
  });

  // Notify users about player vote
  sendMsg(channelId, `${playerId} voted for ${mapVote}`);

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

export const run = () => {
  setUpDataDirs();
  loadChannels();
  const client = new Discord.Client({ intents: [Intents.FLAGS.GUILDS] });
  client.login(process.env.DISCORD_BOT_TOKEN);
};
