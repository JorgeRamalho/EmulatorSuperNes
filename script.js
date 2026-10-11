const DB_NAME = "bancada-nes";
const DB_VERSION = 3;
const SRAM_AUTOSAVE_MS = 60_000;
const SRAM_AUTOSAVE_MOBILE_MS = 120_000;
const FIT_SCREEN_DEBOUNCE_MS = 160;
/** Buffer de áudio RetroArch (ms). Mobile precisa de valor maior para evitar cortes. */
const AUDIO_LATENCY_MOBILE_MS = 224;
const AUDIO_LATENCY_DESKTOP_MS = 48;

let fitScreenTimer = null;
let lastScreenFitKey = "";

const statusNode = document.querySelector("#status");
const noticeNode = document.querySelector("#notice");
const bannerNode = document.querySelector("#banner");
const fpsNode = document.querySelector("#fps");
const emptyNode = document.querySelector("#empty");
const screenNode = document.querySelector("#screen");
const stageNode = document.querySelector("#stage");
const libraryNode = document.querySelector("#library");
const webGameHero = document.querySelector("#web-game-hero");
const webGameTitle = document.querySelector("#web-game-title");
const webGameBlurb = document.querySelector("#web-game-blurb");
const webGameSaveHint = document.querySelector("#web-game-save-hint");
const webPlayButton = document.querySelector("#web-play");
const webContinueButton = document.querySelector("#web-continue");
const webGamePanel = document.querySelector("#web-game-panel");
const webGamePanelBody = document.querySelector("#web-game-panel-body");
const romInput = document.querySelector("#rom-input");
const pauseButton = document.querySelector("#pause");
const restartButton = document.querySelector("#restart");
const saveStateButton = document.querySelector("#save-state");
const loadStateButton = document.querySelector("#load-state");
const fullscreenButton = document.querySelector("#fullscreen");

const state = {
  system: null,
  nesBrowser: null,
  snesEmulator: null,
  snesCanvas: null,
  gameId: null,
  displayTitle: "",
  romName: "",
  romBytes: null,
  running: false,
  sramTimer: null,
  webGames: [],
  pausedByVisibility: false,
};

const DEFAULT_NOTICE = noticeNode?.textContent?.trim() ?? "";

function getAppBaseUrl() {
  const script = document.querySelector("script[src*='script.js']");
  if (script instanceof HTMLScriptElement && script.src) {
    return new URL(".", script.src);
  }
  return new URL("./", window.location.href);
}

function assetUrl(relativePath) {
  const normalized = relativePath.replace(/^\//, "");
  return new URL(normalized, getAppBaseUrl());
}

const DEFAULT_WEB_GAME = {
  id: "donkey-kong-country-usa",
  title: "Donkey Kong Country",
  description: "Super Nintendo · progresso salvo neste navegador.",
  system: "snes",
  file: "roms/donkey-kong-country-usa.sfc",
};

function decodeEmbeddedRomBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isMobilePlayContext() {
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(max-width: 860px)").matches
  );
}

function getSnesCoreName() {
  return isMobilePlayContext() ? "snes9x2010" : "snes9x";
}

function getSnesRetroarchConfig() {
  const mobile = isMobilePlayContext();
  return {
    video_shader_enable: false,
    video_smooth: false,
    video_vsync: false,
    video_hard_sync: false,
    video_frame_delay: 0,
    audio_enable: true,
    audio_sync: true,
    audio_rate_control: true,
    audio_max_timing_skew: 0.05,
    audio_latency: mobile ? AUDIO_LATENCY_MOBILE_MS : AUDIO_LATENCY_DESKTOP_MS,
    audio_resampler_quality: mobile ? 1 : 3,
    run_ahead_enabled: false,
    rewind_enable: false,
  };
}

function configureNostalgistDefaults() {
  if (typeof Nostalgist === "undefined") return;
  Nostalgist.configure({
    retroarchConfig: {
      video_shader_enable: false,
      rewind_enable: false,
      run_ahead_enabled: false,
    },
  });
}

function bindSnesMobileAudioUnlock(canvas) {
  if (!isMobilePlayContext() || !canvas) return;

  const unlock = () => {
    try {
      if (state.snesEmulator && state.running) {
        state.snesEmulator.resume();
      }
    } catch {
      // ignore — gesto do usuário já desbloqueou o contexto na maioria dos casos
    }
    canvas.removeEventListener("pointerdown", unlock);
    canvas.removeEventListener("touchstart", unlock);
  };

  canvas.addEventListener("pointerdown", unlock, { passive: true });
  canvas.addEventListener("touchstart", unlock, { passive: true });
}

function getEmbeddedRomBytes(gameId) {
  const store = globalThis.__BANCADA_EMBEDDED_ROMS__;
  if (!store || typeof store !== "object") return null;
  const payload = store[gameId];
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return decodeEmbeddedRomBase64(payload);
  return null;
}

function setStatus(message, kind = "info") {
  statusNode.textContent = message;
  statusNode.classList.toggle("is-error", kind === "error");
}

function reportFileProblem(message) {
  console.error("[Bancada Retro]", message);
  setStatus(message, "error");
  noticeNode.textContent = message;
  noticeNode.classList.add("is-error");
  bannerNode.hidden = false;
  bannerNode.textContent = message;
  emptyNode.hidden = false;
}

function clearFileProblem() {
  noticeNode.textContent = DEFAULT_NOTICE;
  noticeNode.classList.remove("is-error");
  bannerNode.hidden = true;
  bannerNode.textContent = "";
  statusNode.classList.remove("is-error");
}

function isNesRom(bytes) {
  return (
    bytes.length > 16 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a
  );
}

function nesBytes(bytes) {
  if (isNesRom(bytes)) return bytes;
  if (bytes.length > 528 && isNesRom(bytes.subarray(512))) return bytes.subarray(512);
  return null;
}

function hasSignature(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function readAscii(bytes, start, length) {
  let text = "";
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function stripSmcHeader(bytes) {
  if (bytes.length > 512 && bytes.length % 1024 === 512) {
    const trimmed = bytes.subarray(512);
    if (trimmed.length >= 32768 && trimmed.length % 1024 === 0) return trimmed;
  }
  return bytes;
}

function looksLikeSnesCart(bytes) {
  if (bytes.length < 32768 || bytes.length % 1024 !== 0) return false;
  if (bytes.length < 0x8000) return true;
  const mapMode = bytes[0x7fd5];
  return mapMode === 0x20 || mapMode === 0x21 || mapMode === 0x30 || mapMode === 0x31;
}

function snesRomBytes(bytes, fileName) {
  const lower = fileName.toLowerCase();
  const snesExtension = lower.endsWith(".sfc") || lower.endsWith(".smc");
  const normalized = stripSmcHeader(bytes);

  if (snesExtension && normalized.length >= 32768) {
    return normalized;
  }

  if (looksLikeSnesCart(normalized)) {
    return normalized;
  }

  return null;
}

function explainUnplayable(fileName, bytes) {
  const name = fileName.toLowerCase();

  if (
    name.endsWith(".iso") ||
    name.endsWith(".cue") ||
    name.endsWith(".img") ||
    name.endsWith(".chd") ||
    readAscii(bytes, 0x8001, 5) === "CD001"
  ) {
    return "ISO é imagem de disco (PlayStation, Sega CD, etc.). Aqui só abrimos cartuchos NES (.nes) e Super Nintendo (.sfc, .smc).";
  }

  if (name.endsWith(".7z") || hasSignature(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return "Arquivo .7z: extraia o .nes, .sfc ou .smc e abra o arquivo solto.";
  }

  if (name.endsWith(".rar") || hasSignature(bytes, [0x52, 0x61, 0x72, 0x21])) {
    return "Arquivo .rar: extraia o .nes, .sfc ou .smc e abra o arquivo solto.";
  }

  if (name.endsWith(".zip") || hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return "Esse ZIP não contém ROM de NES nem de SNES. Abra o .nes, .sfc ou .smc que está dentro.";
  }

  if (hasSignature(bytes, [0xce, 0xed, 0x66, 0x66], 0x104)) {
    return "Esse arquivo é de Game Boy. Aqui só executamos NES e SNES.";
  }

  return `${fileName} não é reconhecido. Use .nes (NES) ou .sfc / .smc (Super Nintendo).`;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractRomFromZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;

    if (dataStart > bytes.length) break;

    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));

    if (name.endsWith("/")) {
      offset = dataStart;
      continue;
    }

    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      throw new Error("Não consegui ler esse ZIP. Extraia a ROM e abra o arquivo solto.");
    }

    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) break;

    const compressed = bytes.subarray(dataStart, dataEnd);
    let fileBytes = null;

    if (method === 0) {
      fileBytes = compressed;
    } else if (method === 8) {
      try {
        fileBytes = await inflateRaw(compressed);
      } catch {
        throw new Error("Não consegui descompactar esse ZIP. Extraia a ROM e abra o arquivo solto.");
      }
    }

    if (fileBytes) {
      const baseName = name.split("/").pop() || "jogo.rom";
      const nes = nesBytes(fileBytes);
      if (nes) {
        return { system: "nes", name: baseName, bytes: new Uint8Array(nes) };
      }
      const snes = snesRomBytes(fileBytes, baseName);
      if (snes) {
        return { system: "snes", name: baseName, bytes: new Uint8Array(snes) };
      }
    }

    offset = dataEnd;
  }

  return null;
}

async function findPlayableRom(fileName, bytes) {
  const nes = nesBytes(bytes);
  if (nes) {
    return { system: "nes", name: fileName, bytes: new Uint8Array(nes) };
  }

  const snes = snesRomBytes(bytes, fileName);
  if (snes) {
    return { system: "snes", name: fileName, bytes: new Uint8Array(snes) };
  }

  const looksLikeZip = fileName.toLowerCase().endsWith(".zip") || hasSignature(bytes, [0x50, 0x4b, 0x03, 0x04]);
  if (looksLikeZip) {
    const extracted = await extractRomFromZip(bytes);
    if (extracted) return extracted;
  }

  throw new Error(explainUnplayable(fileName, bytes));
}

function ensureDatabaseStores(database) {
  if (!database.objectStoreNames.contains("roms")) {
    database.createObjectStore("roms", { keyPath: "name" });
  }
  if (!database.objectStoreNames.contains("states")) {
    database.createObjectStore("states", { keyPath: "name" });
  }
  if (!database.objectStoreNames.contains("sram")) {
    database.createObjectStore("sram", { keyPath: "gameId" });
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      ensureDatabaseStores(request.result);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getRecordSafe(storeName, key) {
  try {
    return await getRecord(storeName, key);
  } catch (error) {
    console.warn(`[Bancada Retro] Leitura ${storeName}/${key} ignorada:`, error);
    return null;
  }
}

async function putRecordSafe(storeName, record) {
  try {
    await putRecord(storeName, record);
    return true;
  } catch (error) {
    console.warn(`[Bancada Retro] Gravação em ${storeName} falhou:`, error);
    return false;
  }
}

function isHttpOrigin() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function storeRequest(storeName, mode, run) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = run(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

function putRecord(storeName, record) {
  return storeRequest(storeName, "readwrite", (store) => store.put(record));
}

function getRecord(storeName, key) {
  return storeRequest(storeName, "readonly", (store) => store.get(key));
}

function getAllRecords(storeName) {
  return storeRequest(storeName, "readonly", (store) => store.getAll());
}

function deleteRecord(storeName, key) {
  return storeRequest(storeName, "readwrite", (store) => store.delete(key));
}

function getSaveKey() {
  if (state.gameId) return state.gameId;
  if (state.romName) return `local:${state.romName}`;
  return null;
}

function formatWhen(timestamp) {
  return new Date(timestamp).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stopSramAutosave() {
  if (state.sramTimer) {
    clearInterval(state.sramTimer);
    state.sramTimer = null;
  }
}

function startSramAutosave() {
  stopSramAutosave();
  if (!state.gameId || state.system !== "snes") return;
  const interval = isMobilePlayContext() ? SRAM_AUTOSAVE_MOBILE_MS : SRAM_AUTOSAVE_MS;
  state.sramTimer = window.setInterval(() => {
    persistSram().catch(() => {});
  }, interval);
}

async function loadSramBytes(gameKey) {
  const record = await getRecordSafe("sram", gameKey);
  if (!record || !record.data) return null;
  return record.data instanceof Uint8Array ? record.data : new Uint8Array(record.data);
}

async function persistSram() {
  const gameKey = getSaveKey();
  if (!gameKey || !state.running || state.system !== "snes" || !state.snesEmulator) return;

  const blob = await state.snesEmulator.saveSRAM();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await putRecordSafe("sram", {
    gameId: gameKey,
    system: "snes",
    data: bytes,
    savedAt: Date.now(),
  });
  await refreshWebGameSaveHints();
}

async function hasWebGameProgress(gameId) {
  const sram = await getRecordSafe("sram", gameId);
  const quick = await getRecordSafe("states", gameId);
  return Boolean(sram || quick);
}

async function refreshWebGameSaveHints() {
  const game = state.webGames[0];
  if (!game) return;

  const hasProgress = await hasWebGameProgress(game.id);
  if (webContinueButton) webContinueButton.disabled = !hasProgress;
  const panelContinue = webGamePanelBody.querySelector(".web-game-panel-actions button:last-child");
  if (panelContinue instanceof HTMLButtonElement) {
    panelContinue.disabled = !hasProgress;
  }

  const sram = await getRecordSafe("sram", game.id);
  const quick = await getRecordSafe("states", game.id);

  let hint = "O progresso do jogo (save no cartucho) grava sozinho enquanto você joga.";
  if (quick) {
    hint += ` Último salvar rápido: ${formatWhen(quick.savedAt)}.`;
  } else if (sram) {
    hint += ` Save do cartucho: ${formatWhen(sram.savedAt)}.`;
  } else {
    hint += " Ainda não há save neste navegador.";
  }
  webGameSaveHint.textContent = hint;
}

function bindWebGameActions(game) {
  webPlayButton.onclick = () => {
    launchWebGame(game, { continueSession: false }).catch((error) => {
      reportFileProblem(error instanceof Error ? error.message : "Não foi possível iniciar o jogo.");
    });
  };
  webContinueButton.onclick = () => {
    launchWebGame(game, { continueSession: true }).catch((error) => {
      reportFileProblem(error instanceof Error ? error.message : "Não foi possível continuar.");
    });
  };
}

function renderWebGamePanel(game) {
  webGamePanelBody.replaceChildren();

  const title = document.createElement("h3");
  title.textContent = game.title;

  const description = document.createElement("p");
  description.textContent = game.description || "";

  const actions = document.createElement("div");
  actions.className = "web-game-panel-actions";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "button primary";
  play.textContent = "Jogar";
  play.addEventListener("click", () => {
    launchWebGame(game, { continueSession: false }).catch((error) => {
      reportFileProblem(error instanceof Error ? error.message : "Não foi possível iniciar o jogo.");
    });
  });

  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.textContent = "Continuar";
  continueBtn.addEventListener("click", () => {
    launchWebGame(game, { continueSession: true }).catch((error) => {
      reportFileProblem(error instanceof Error ? error.message : "Não foi possível continuar.");
    });
  });

  actions.append(play, continueBtn);
  webGamePanelBody.append(title, description, actions);
}

async function loadWebGames() {
  try {
    const response = await fetch(assetUrl("games/manifest.json"), { cache: "no-cache" });
    if (!response.ok) throw new Error("manifesto não encontrado");
    const manifest = await response.json();
    state.webGames = Array.isArray(manifest.games) ? manifest.games : [];
  } catch {
    state.webGames = [];
  }

  if (state.webGames.length === 0 && getEmbeddedRomBytes(DEFAULT_WEB_GAME.id)) {
    state.webGames = [DEFAULT_WEB_GAME];
  }

  const game = state.webGames[0];
  if (!game) {
    webGameHero.hidden = true;
    webGamePanel.hidden = true;
    return;
  }

  webGameHero.hidden = false;
  webGamePanel.hidden = false;
  webGameTitle.textContent = game.title;
  webGameBlurb.textContent = game.description || "";
  bindWebGameActions(game);
  renderWebGamePanel(game);
  await refreshWebGameSaveHints();
}

async function launchWebGame(game, options = {}) {
  if (!isHttpOrigin()) {
    throw new Error(
      "Para Jogar na web, use um servidor local: na pasta do projeto rode python -m http.server 8765 e abra http://127.0.0.1:8765/ (não abra o HTML com duplo clique).",
    );
  }

  let bytes = getEmbeddedRomBytes(game.id);
  let fileName = game.file.split("/").pop() || "jogo.sfc";

  if (!bytes) {
    const romPathCandidates = [
      `games/${game.file}`,
      ...(Array.isArray(game.altFiles) ? game.altFiles.map((file) => `games/${file}`) : []),
    ];

    let romUrl = null;
    let response = null;
    for (const path of romPathCandidates) {
      const url = assetUrl(path);
      const attempt = await fetch(url, { cache: "no-cache" });
      if (attempt.ok) {
        romUrl = url;
        response = attempt;
        break;
      }
    }

    if (!response || !romUrl) {
      const tried = romPathCandidates.map((path) => assetUrl(path).href).join(" · ");
      throw new Error(
        `ROM não encontrada (${game.file}). Rode npm run embed-rom e faça deploy de novo, ou coloque o .sfc em games/roms/. URLs testadas: ${tried}`,
      );
    }

    bytes = new Uint8Array(await response.arrayBuffer());
    fileName = romUrl.pathname.split("/").pop() || fileName;
  }
  const playable = await findPlayableRom(fileName, bytes);
  playable.gameId = game.id;
  playable.displayTitle = game.title;
  playable.name = fileName;

  await startGame(playable);

  if (options.continueSession) {
    const quick = await getRecordSafe("states", game.id);
    if (quick) {
      try {
        await loadState();
        setStatus(`Continuando ${game.title} — salvar rápido de ${formatWhen(quick.savedAt)}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "save inválido";
        setStatus(`Jogo aberto; salvar rápido ignorado (${detail}). Use o save dentro do jogo.`, "error");
      }
    } else {
      setStatus(`Continuando ${game.title} — save do cartucho carregado.`);
    }
  } else {
    setStatus(`Jogando ${game.title}`);
  }

  await refreshWebGameSaveHints();
}

function ensureNesBrowser() {
  if (state.nesBrowser) return state.nesBrowser;

  if (typeof jsnes === "undefined") {
    throw new Error("O núcleo jsnes não carregou. Confira vendor/jsnes.min.js.");
  }

  state.nesBrowser = new jsnes.Browser({
    container: screenNode,
    onError(error) {
      state.running = false;
      reportFileProblem(error.message || "O emulador NES parou por um erro.");
      syncControls();
    },
  });

  state.nesBrowser.fitInParent();
  return state.nesBrowser;
}

async function destroyActiveEmulator() {
  stopSramAutosave();
  try {
    await persistSram();
  } catch {
    // ignore autosave errors on exit
  }

  if (state.snesEmulator) {
    try {
      state.snesEmulator.exit({ removeCanvas: false });
    } catch {
      // ignore teardown errors
    }
    state.snesEmulator = null;
  }

  if (state.nesBrowser) {
    state.nesBrowser.destroy();
    state.nesBrowser = null;
  }

  state.snesCanvas = null;
  screenNode.replaceChildren();
}

function syncControls() {
  const hasRom = state.romBytes !== null;
  pauseButton.disabled = !hasRom;
  restartButton.disabled = !hasRom;
  saveStateButton.disabled = !hasRom;
  loadStateButton.disabled = !hasRom;
  pauseButton.textContent = hasRom && !state.running ? "Continuar" : "Pausar";
}

function fitScreen() {
  if (state.system === "nes" && state.nesBrowser) {
    state.nesBrowser.fitInParent();
    return;
  }

  if (state.system === "snes" && isMobilePlayContext()) {
    return;
  }

  const canvas = state.snesCanvas || screenNode.querySelector("canvas");
  if (!canvas) return;

  const parentWidth = screenNode.clientWidth;
  const parentHeight = screenNode.clientHeight;
  const fitKey = `${parentWidth}x${parentHeight}`;
  if (fitKey === lastScreenFitKey) return;
  lastScreenFitKey = fitKey;

  const ratio = 256 / 224;
  if (parentWidth / parentHeight > ratio) {
    canvas.style.height = `${parentHeight}px`;
    canvas.style.width = `${Math.round(parentHeight * ratio)}px`;
  } else {
    canvas.style.width = `${parentWidth}px`;
    canvas.style.height = `${Math.round(parentWidth / ratio)}px`;
  }
}

function scheduleFitScreen() {
  if (fitScreenTimer !== null) {
    window.clearTimeout(fitScreenTimer);
  }
  fitScreenTimer = window.setTimeout(() => {
    fitScreenTimer = null;
    requestAnimationFrame(fitScreen);
  }, FIT_SCREEN_DEBOUNCE_MS);
}

function systemLabel(system) {
  return system === "snes" ? "SNES" : "NES";
}

async function refreshLibrary() {
  if (!libraryNode) return;

  const roms = await getAllRecords("roms");
  roms.sort((left, right) => right.savedAt - left.savedAt);
  libraryNode.replaceChildren();

  if (roms.length === 0) {
    const item = document.createElement("li");
    item.className = "library-empty";
    item.textContent = "Nenhuma ROM guardada neste navegador.";
    libraryNode.append(item);
    return;
  }

  for (const rom of roms) {
    const item = document.createElement("li");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "library-open";
    const romSystem = rom.system === "snes" ? "snes" : "nes";
    openButton.textContent = `${rom.name} · ${systemLabel(romSystem)}`;
    openButton.addEventListener("click", () => {
      startGame({
        system: romSystem,
        name: rom.name,
        bytes: new Uint8Array(rom.bytes),
      }).catch((error) => {
        reportFileProblem(error instanceof Error ? error.message : "Não foi possível abrir essa ROM.");
      });
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "library-remove";
    removeButton.textContent = "Remover";
    removeButton.addEventListener("click", async () => {
      await deleteRecord("roms", rom.name);
      await deleteRecord("states", `local:${rom.name}`);
      if (state.romName === rom.name) {
        setStatus(`${rom.name} saiu da lista local. A sessão atual continua aberta.`);
      }
      await refreshLibrary();
    });

    item.append(openButton, removeButton);
    libraryNode.append(item);
  }
}

async function startGame(playable) {
  await destroyActiveEmulator();

  state.system = playable.system;
  state.gameId = playable.gameId ?? null;
  state.displayTitle = playable.displayTitle ?? playable.name;
  state.romName = playable.name;
  state.romBytes = playable.bytes;
  state.running = false;
  clearFileProblem();
  setStatus(`Carregando ${state.displayTitle} (${systemLabel(playable.system)})…`);

  try {
    if (playable.system === "nes") {
      const browser = ensureNesBrowser();
      browser.loadROM(playable.bytes);
      state.running = true;
      emptyNode.hidden = true;
      setStatus(`Rodando ${state.displayTitle} (NES)`);
    } else if (playable.system === "snes") {
      if (typeof Nostalgist === "undefined") {
        throw new Error("O núcleo SNES não carregou. Confira vendor/nostalgist.umd.js.");
      }

      if (!isHttpOrigin()) {
        setStatus(
          "Aviso: SNES precisa de http://127.0.0.1:8765 (python -m http.server 8765). Tentando mesmo assim…",
          "error",
        );
      }

      const snesCore = getSnesCoreName();
      const mobile = isMobilePlayContext();
      setStatus(
        mobile
          ? `Baixando núcleo SNES (${snesCore}, otimizado para celular)… primeira vez pode levar até 1 minuto.`
          : `Baixando núcleo SNES (${snesCore})… na primeira vez pode levar até 1 minuto. Precisa de internet.`,
      );

      const canvas = document.createElement("canvas");
      canvas.className = "snes-canvas";
      if (mobile) {
        canvas.classList.add("snes-canvas--mobile");
      }
      screenNode.append(canvas);
      state.snesCanvas = canvas;

      const launchOptions = {
        element: canvas,
        core: snesCore,
        retroarchConfig: getSnesRetroarchConfig(),
        rom: {
          fileContent: playable.bytes,
          fileName: playable.name,
        },
      };

      const saveKey = getSaveKey();
      if (saveKey) {
        try {
          const sramBytes = await loadSramBytes(saveKey);
          if (sramBytes && sramBytes.length > 0) {
            launchOptions.sram = {
              fileContent: sramBytes,
              fileName: "battery.srm",
            };
          }
        } catch (error) {
          console.warn("[Bancada Retro] SRAM não carregado, iniciando jogo limpo:", error);
        }
      }

      state.snesEmulator = await Nostalgist.launch(launchOptions);
      bindSnesMobileAudioUnlock(canvas);

      state.running = true;
      emptyNode.hidden = true;
      startSramAutosave();
      setStatus(
        mobile
          ? `Rodando ${state.displayTitle} (SNES) — toque na tela se o som não começar.`
          : `Rodando ${state.displayTitle} (SNES) — clique na tela se o som não começar.`,
      );
    } else {
      throw new Error("Sistema não suportado.");
    }
  } catch (error) {
    await destroyActiveEmulator();
    state.romBytes = null;
    state.gameId = null;
    state.displayTitle = "";
    state.romName = "";
    state.system = null;
    state.running = false;
    syncControls();
    throw error;
  }

  syncControls();
  requestAnimationFrame(fitScreen);
}

async function openRomFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const playable = await findPlayableRom(file.name, bytes);

  await startGame(playable);

  try {
    await putRecord("roms", {
      name: playable.name,
      system: playable.system,
      bytes: playable.bytes,
      savedAt: Date.now(),
    });
    await refreshLibrary();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erro desconhecido";
    setStatus(
      `Jogo rodando, mas não coube na lista local (${detail}). O arquivo continua aberto nesta sessão.`,
      "error",
    );
  }
}

function togglePause() {
  if (state.romBytes === null) return;

  if (state.system === "nes" && state.nesBrowser) {
    if (state.running) {
      state.nesBrowser.stop();
      state.running = false;
      setStatus(`Pausado — ${state.romName}`);
    } else {
      state.nesBrowser.start();
      state.running = true;
      setStatus(`Rodando ${state.romName} (NES)`);
    }
  } else if (state.system === "snes" && state.snesEmulator) {
    if (state.running) {
      state.snesEmulator.pause();
      state.running = false;
      setStatus(`Pausado — ${state.romName}`);
    } else {
      state.snesEmulator.resume();
      state.running = true;
      setStatus(`Rodando ${state.romName} (SNES)`);
    }
  }

  syncControls();
}

function restartRom() {
  if (state.romBytes === null || state.system === null) return;

  if (state.system === "snes" && state.snesEmulator) {
    state.snesEmulator.sendCommand("RESET");
    state.running = true;
    setStatus(`Reiniciado — ${state.romName} (SNES)`);
    syncControls();
    return;
  }

  startGame({
    system: state.system,
    name: state.romName,
    bytes: state.romBytes,
  })
    .then(() => {
      setStatus(`Reiniciado — ${state.romName} (${systemLabel(state.system)})`);
    })
    .catch((error) => {
      reportFileProblem(error instanceof Error ? error.message : "Não foi possível reiniciar.");
    });
}

async function saveState() {
  const saveKey = getSaveKey();
  if (!saveKey) return;

  if (state.system === "nes" && state.nesBrowser) {
    await putRecord("states", {
      name: saveKey,
      system: "nes",
      data: state.nesBrowser.nes.toJSON(),
      savedAt: Date.now(),
    });
    setStatus(`Estado rápido salvo — ${state.displayTitle || state.romName}`);
    await refreshWebGameSaveHints();
    return;
  }

  if (state.system === "snes" && state.snesEmulator) {
    const saved = await state.snesEmulator.saveState();
    const stateBytes = await saved.state.getUint8Array();
    await putRecord("states", {
      name: saveKey,
      system: "snes",
      data: stateBytes,
      savedAt: Date.now(),
    });
    await persistSram();
    setStatus(`Estado rápido salvo — ${state.displayTitle || state.romName}`);
    await refreshWebGameSaveHints();
    return;
  }

  throw new Error("Nenhum jogo em execução para salvar.");
}

async function loadState() {
  const saveKey = getSaveKey();
  if (!saveKey) return;

  const record = await getRecordSafe("states", saveKey);
  if (!record) {
    setStatus("Nenhum estado rápido salvo para este jogo.", "error");
    return;
  }

  if (record.system !== state.system) {
    setStatus("O estado salvo é de outro console.", "error");
    return;
  }

  if (record.system === "nes" && state.nesBrowser) {
    state.nesBrowser.nes.fromJSON(record.data);
    if (!state.running) {
      state.nesBrowser.start();
      state.running = true;
    }
  } else if (record.system === "snes" && state.snesEmulator) {
    await state.snesEmulator.loadState(record.data);
    if (!state.running) {
      state.snesEmulator.resume();
      state.running = true;
    }
  } else {
    throw new Error("Não foi possível carregar o estado.");
  }

  syncControls();
  setStatus(`Estado rápido carregado — ${state.displayTitle || state.romName}`);
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }

  await stageNode.requestFullscreen();
}

romInput.addEventListener("change", () => {
  const file = romInput.files && romInput.files[0];
  romInput.value = "";
  if (!file) return;

  openRomFile(file).catch((error) => {
    const message = error instanceof Error ? error.message : "Não foi possível abrir essa ROM.";
    reportFileProblem(message);
  });
});

pauseButton.addEventListener("click", togglePause);
restartButton.addEventListener("click", restartRom);
saveStateButton.addEventListener("click", () => {
  saveState().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Não foi possível salvar o estado.", "error");
  });
});
loadStateButton.addEventListener("click", () => {
  loadState().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Não foi possível carregar o estado.", "error");
  });
});
fullscreenButton.addEventListener("click", () => {
  toggleFullscreen().catch(() => {
    setStatus("Este navegador bloqueou a tela cheia.", "error");
  });
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  stageNode.classList.toggle("is-dropping", event.target instanceof Node && stageNode.contains(event.target));
});

window.addEventListener("dragleave", (event) => {
  if (!(event.relatedTarget instanceof Node) || !stageNode.contains(event.relatedTarget)) {
    stageNode.classList.remove("is-dropping");
  }
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  stageNode.classList.remove("is-dropping");
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (!file) return;

  openRomFile(file).catch((error) => {
    const message = error instanceof Error ? error.message : "Não foi possível abrir essa ROM.";
    reportFileProblem(message);
  });
});

document.addEventListener("keydown", (event) => {
  if (!state.running) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return;
  }
  if (event.key.startsWith("Arrow") || event.key === " ") {
    event.preventDefault();
  }
});

document.addEventListener("fullscreenchange", () => {
  lastScreenFitKey = "";
  scheduleFitScreen();
});
window.addEventListener("resize", scheduleFitScreen, { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", scheduleFitScreen, { passive: true });
}

document.addEventListener("visibilitychange", () => {
  if (!state.snesEmulator || state.system !== "snes") return;
  if (document.hidden) {
    if (state.running) {
      state.snesEmulator.pause();
      state.pausedByVisibility = true;
    }
    return;
  }
  if (state.pausedByVisibility) {
    state.snesEmulator.resume();
    state.running = true;
    state.pausedByVisibility = false;
    syncControls();
  }
});

window.setInterval(() => {
  if (!state.running) {
    fpsNode.textContent = "— fps";
    return;
  }

  if (state.system === "nes" && state.nesBrowser) {
    const fps = Number(state.nesBrowser.nes.getFPS());
    fpsNode.textContent = `${Math.round(Number.isFinite(fps) ? fps : 0)} fps`;
    return;
  }

  if (state.system === "snes") {
    fpsNode.textContent = "SNES ativo";
  }
}, 1000);

window.addEventListener("beforeunload", () => {
  persistSram();
});

function showOriginHints() {
  if (isHttpOrigin()) return;
  setStatus(
    "Você abriu o arquivo direto (file://). Para Donkey Kong Country na web, use: python -m http.server 8765 → http://127.0.0.1:8765/",
    "error",
  );
}

async function maybeAutoplayWebGame() {
  const params = new URLSearchParams(window.location.search);
  const autoplay =
    params.get("autoplay") === "1" || document.body.classList.contains("autoplay-web-game");
  if (!autoplay) return;

  const game = state.webGames[0];
  if (!game) {
    setStatus("ROM do jogo na web não configurada. Veja games/LEIA-ME.md.", "error");
    return;
  }

  const continueSession = params.get("continuar") === "1";
  await launchWebGame(game, { continueSession });
}

configureNostalgistDefaults();
syncControls();
showOriginHints();
loadWebGames()
  .then(() => maybeAutoplayWebGame())
  .catch((error) => {
    console.warn("[Bancada Retro] Vitrine não carregou:", error);
  });
refreshLibrary().catch((error) => {
  console.warn("[Bancada Retro] Lista local indisponível:", error);
});
