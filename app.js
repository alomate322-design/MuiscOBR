// Ravenloft Music — синхронизированный музыкальный плеер для Owlbear Rodeo.
// Собственная реализация на базе официального @owlbear-rodeo/sdk — без
// единой строки кода DJinni. Синхронизация — через встроенные API комнаты
// (room metadata) и трансляции (broadcast) самой платформы; свой сервер не
// нужен.
//
// Два слоя данных:
//  - BUILTIN_FOLDERS (data.js) — стартовый плейлист, зашит в файл, не
//    меняется во время игры.
//  - "library" (room metadata) — всё, что мастер добавил/скрыл/переименовал
//    через интерфейс. Накладывается поверх BUILTIN_FOLDERS на лету, видно
//    сразу у всех, кто сейчас в комнате.

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/lib/index.js";
import { BUILTIN_FOLDERS } from "./data.js";

const STATE_KEY = "com.ravenloft.music/state";
const LIB_KEY = "com.ravenloft.music/library";
const SFX_CHANNEL = "com.ravenloft.music/sfx";
const LS_PREFIX = "ravenloft-music:";

function clamp01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function toDirectUrl(link) {
  if (/dropbox\.com/.test(link) && /[?&]dl=0(?:&|$)/.test(link)) {
    return link.replace("dl=0", "dl=1");
  }
  return link;
}

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeLocal(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* приватный режим / квота — не критично */
  }
}

function freshId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// ---------- слияние встроенного плейлиста с library ----------

let library = { hidden: [], overrides: {}, customStreams: {}, customFolders: [] };
let effectiveFolders = [];
const STREAM_INDEX = new Map(); // streamId -> {folder, stream}

// Map/Set используют строгое сравнение ключей (Map.get(101) !== Map.get("101")),
// а id из data.js — числа. Приводим id к строке ОДИН раз здесь и дальше везде
// (dataset, room metadata, обработчики кликов) работаем только с этой строкой —
// иначе кнопки встроенных стримов просто не находили бы себя в STREAM_INDEX.
function normalizeId(stream) {
  return String(stream.id);
}

function applyOverride(stream) {
  const id = normalizeId(stream);
  const o = library.overrides?.[id];
  return o ? { ...stream, id, ...o } : { ...stream, id };
}

function computeEffectiveFolders() {
  const hidden = new Set((library.hidden || []).map(String));
  const folders = [];

  for (const f of BUILTIN_FOLDERS) {
    const extra = library.customStreams?.[f.id] || [];
    const streams = [...f.streams, ...extra]
      .filter((s) => !hidden.has(normalizeId(s)))
      .map(applyOverride);
    folders.push({ ...f, id: String(f.id), streams });
  }
  for (const cf of library.customFolders || []) {
    const streams = (cf.streams || []).filter((s) => !hidden.has(normalizeId(s))).map(applyOverride);
    folders.push({ ...cf, id: String(cf.id), builtin: false, streams });
  }

  STREAM_INDEX.clear();
  for (const folder of folders) {
    for (const stream of folder.streams) STREAM_INDEX.set(stream.id, { folder, stream });
  }
  effectiveFolders = folders;
}

// ---------- аудио ----------

let role = "PLAYER";
let audioUnlocked = false;
let localMasterVolume = readLocal("masterVolume", 1);
let localMuted = readLocal("muted", false);
let roomState = { streams: {} };
const audioEls = new Map();

function getOrCreateAudio(streamId) {
  let el = audioEls.get(streamId);
  if (!el) {
    el = new Audio();
    el.preload = "none";
    el.addEventListener("error", () => {
      console.warn("[Ravenloft Music] ошибка воспроизведения потока", streamId, el.src, el.error);
    });
    audioEls.set(streamId, el);
  }
  return el;
}

function applyVolume(el, baseVolumePercent) {
  const combined = clamp01((baseVolumePercent ?? 0) / 100) * clamp01(localMasterVolume) * (localMuted ? 0 : 1);
  try {
    el.volume = clamp01(combined);
  } catch (e) {
    console.warn("[Ravenloft Music] не удалось выставить громкость", e);
  }
}

function syncStream(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  if (!entry || entry.stream.type !== "loop") return;
  const { stream } = entry;
  const state = roomState.streams?.[streamId];
  const el = getOrCreateAudio(streamId);

  if (!state || !state.playing) {
    if (!el.paused) el.pause();
    return;
  }

  const track = stream.tracks[state.trackIndex ?? 0];
  if (!track) return;

  const wantSrc = toDirectUrl(track.link);
  if (el.dataset.link !== wantSrc) {
    el.src = wantSrc;
    el.dataset.link = wantSrc;
    el.loop = stream.loop ?? track.loop;
  }

  applyVolume(el, state.volume ?? stream.volume ?? 80);

  if (!audioUnlocked) return;

  const startedAt = typeof state.startedAt === "number" ? state.startedAt : Date.now();
  const elapsedSec = Math.max(0, (Date.now() - startedAt) / 1000);
  const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  const target = el.loop && duration ? elapsedSec % duration : elapsedSec;

  if (el.paused) {
    try {
      el.currentTime = target;
    } catch {
      /* метаданные ещё не загружены — play() подождёт сам */
    }
    el.play().catch((err) => {
      console.warn("[Ravenloft Music] play() отклонён браузером", err);
      showUnlockOverlay();
    });
  } else if (duration && Math.abs(el.currentTime - target) > 1.5) {
    try {
      el.currentTime = target;
    } catch {
      /* ignore */
    }
  }
}

function syncAll() {
  for (const streamId of STREAM_INDEX.keys()) syncStream(streamId);
}

async function writeStreamState(streamId, patch) {
  const next = {
    streams: {
      ...roomState.streams,
      [streamId]: { ...(roomState.streams[streamId] || {}), ...patch },
    },
  };
  roomState = next;
  await OBR.room.setMetadata({ [STATE_KEY]: next });
}

async function toggleStream(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  if (!entry) return;
  const current = roomState.streams[streamId];
  if (current?.playing) {
    await writeStreamState(streamId, { playing: false });
  } else {
    await writeStreamState(streamId, {
      playing: true,
      trackIndex: current?.trackIndex ?? 0,
      startedAt: Date.now(),
      volume: current?.volume ?? entry.stream.volume ?? 80,
    });
  }
}

async function setStreamVolume(streamId, volumePercent) {
  await writeStreamState(streamId, { volume: volumePercent });
}

function playSfxLocally(link, volumePercent) {
  const el = new Audio(toDirectUrl(link));
  applyVolume(el, volumePercent);
  el.play().catch((err) => console.warn("[Ravenloft Music] SFX play() отклонён", err));
}

async function triggerSfx(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  const track = entry?.stream.tracks[0];
  if (!track) return;
  await OBR.broadcast.sendMessage(
    SFX_CHANNEL,
    { link: track.link, volume: entry.stream.volume },
    { destination: "ALL" },
  );
}

// ---------- редактирование библиотеки (только у мастера) ----------

let editMode = false;

async function writeLibrary(next) {
  library = next;
  try {
    await OBR.room.setMetadata({ [LIB_KEY]: next });
  } catch (err) {
    console.error("[Ravenloft Music] не удалось сохранить изменения", err);
    alert("Не сохранилось — похоже, в комнате закончилось место под данные расширений. Удали что-нибудь лишнее и попробуй снова.");
  }
}

async function addStream(folderId, { name, icon, link, type, loop }) {
  const id = freshId("c");
  const stream = {
    id,
    name: name || "Без названия",
    icon: icon || (type === "oneshot" ? "🔊" : "🎵"),
    volume: 80,
    type,
    loop: type === "loop" ? !!loop : undefined,
    tracks: [{ name: name || "Без названия", link, loop: !!loop }],
  };
  const isBuiltinFolder = BUILTIN_FOLDERS.some((f) => String(f.id) === String(folderId));
  if (isBuiltinFolder) {
    const customStreams = { ...(library.customStreams || {}) };
    customStreams[folderId] = [...(customStreams[folderId] || []), stream];
    await writeLibrary({ ...library, customStreams });
  } else {
    const customFolders = (library.customFolders || []).map((f) =>
      f.id === folderId ? { ...f, streams: [...f.streams, stream] } : f,
    );
    await writeLibrary({ ...library, customFolders });
  }
}

async function addFolder({ name, color }) {
  const id = freshId("cf");
  const customFolders = [...(library.customFolders || []), { id, name: name || "Новая папка", color: color || "#555", streams: [] }];
  await writeLibrary({ ...library, customFolders });
}

async function removeStream(folderId, streamId) {
  if (String(streamId).startsWith("c-")) {
    const customStreams = { ...(library.customStreams || {}) };
    if (customStreams[folderId]) customStreams[folderId] = customStreams[folderId].filter((s) => s.id !== streamId);
    const customFolders = (library.customFolders || []).map((f) =>
      f.id === folderId ? { ...f, streams: f.streams.filter((s) => s.id !== streamId) } : f,
    );
    await writeLibrary({ ...library, customStreams, customFolders });
  } else {
    const hidden = Array.from(new Set([...(library.hidden || []), streamId]));
    await writeLibrary({ ...library, hidden });
  }
}

async function removeFolder(folderId) {
  const customFolders = (library.customFolders || []).filter((f) => f.id !== folderId);
  await writeLibrary({ ...library, customFolders });
}

async function setStreamOverride(streamId, patch) {
  const overrides = { ...(library.overrides || {}), [streamId]: { ...(library.overrides?.[streamId] || {}), ...patch } };
  await writeLibrary({ ...library, overrides });
}

// ---------- UI ----------

const root = document.getElementById("app");
const unlockOverlay = document.getElementById("unlock-overlay");
const editToggleBtn = document.getElementById("edit-toggle");

function showUnlockOverlay() {
  unlockOverlay.hidden = false;
}
function hideUnlockOverlay() {
  unlockOverlay.hidden = true;
}
unlockOverlay.querySelector("button").addEventListener("click", () => {
  audioUnlocked = true;
  hideUnlockOverlay();
  const primer = new Audio();
  primer.volume = 0;
  primer.play().catch(() => {});
  syncAll();
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFolder(folder) {
  const wrap = el("details", "folder");
  wrap.style.setProperty("--dot", folder.color || "#666");
  wrap.open = false;

  const summary = el("summary");
  const dot = el("span", "dot");
  summary.appendChild(dot);
  summary.appendChild(el("span", "folder-name", folder.name));
  if (editMode && !folder.builtin) {
    const del = el("button", "icon-btn danger", "✕");
    del.title = "Удалить папку целиком";
    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (confirm(`Удалить папку «${folder.name}» вместе со всем, что в ней?`)) removeFolder(folder.id);
    });
    summary.appendChild(del);
  }
  wrap.appendChild(summary);

  const body = el("div", "folder-body");
  for (const stream of folder.streams) body.appendChild(renderStream(folder, stream));
  if (editMode) body.appendChild(renderAddStreamForm(folder));
  wrap.appendChild(body);

  return wrap;
}

function renderStream(folder, stream) {
  const row = el("div", "stream-row");
  row.dataset.streamId = stream.id;

  const main = el("div", "stream-main");

  if (stream.type === "oneshot") {
    const btn = el("button", "sfx-btn", `${stream.icon || ""} ${stream.name}`);
    btn.disabled = role !== "GM";
    btn.addEventListener("click", () => triggerSfx(stream.id));
    main.appendChild(btn);
  } else {
    const playBtn = el("button", "play-btn", "▶");
    playBtn.disabled = role !== "GM";
    playBtn.addEventListener("click", () => toggleStream(stream.id));
    row._playBtn = playBtn;

    const label = el("span", "stream-label", `${stream.icon || ""} ${stream.name}`);

    const volume = el("input", "vol");
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    volume.value = String(stream.volume ?? 80);
    volume.disabled = role !== "GM";
    volume.addEventListener("input", () => setStreamVolume(stream.id, Number(volume.value)));
    row._volume = volume;

    main.append(playBtn, label, volume);
  }

  row.appendChild(main);

  if (editMode) {
    const tools = el("div", "stream-tools");
    const rename = el("button", "icon-btn", "✎");
    rename.title = "Переименовать / иконка / зацикливание";
    rename.addEventListener("click", () => toggleInlineEdit(row, folder, stream));
    const del = el("button", "icon-btn danger", "✕");
    del.title = "Скрыть / удалить";
    del.addEventListener("click", () => removeStream(folder.id, stream.id));
    tools.append(rename, del);
    row.appendChild(tools);
  }

  return row;
}

function toggleInlineEdit(row, folder, stream) {
  const existing = row.querySelector(".inline-edit");
  if (existing) {
    existing.remove();
    return;
  }
  const box = el("div", "inline-edit");

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название";
  nameInput.value = stream.name;

  const iconInput = el("input", "text-input icon-input");
  iconInput.placeholder = "🎵";
  iconInput.value = stream.icon || "";

  box.append(nameInput, iconInput);

  let loopCheckbox;
  if (stream.type === "loop") {
    const loopLabel = el("label", "checkbox-label");
    loopCheckbox = document.createElement("input");
    loopCheckbox.type = "checkbox";
    loopCheckbox.checked = !!stream.loop;
    loopLabel.append(loopCheckbox, document.createTextNode(" зациклен"));
    box.appendChild(loopLabel);
  }

  const save = el("button", "small-btn", "Сохранить");
  save.addEventListener("click", async () => {
    const patch = { name: nameInput.value.trim() || stream.name, icon: iconInput.value.trim() };
    if (loopCheckbox) patch.loop = loopCheckbox.checked;
    await setStreamOverride(stream.id, patch);
    box.remove();
  });
  box.appendChild(save);

  row.appendChild(box);
}

function renderAddStreamForm(folder) {
  const box = el("div", "add-form");
  const toggle = el("button", "add-toggle", "+ добавить трек");
  const form = el("div", "add-form-body");
  form.hidden = true;

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название";
  const iconInput = el("input", "text-input icon-input");
  iconInput.placeholder = "🎵";
  const linkInput = el("input", "text-input");
  linkInput.placeholder = "Ссылка (mp3, Dropbox…)";

  const typeSelect = document.createElement("select");
  typeSelect.className = "text-input";
  const optLoop = document.createElement("option");
  optLoop.value = "loop";
  optLoop.textContent = "Зацикленный (эмбиент/бой)";
  const optOneshot = document.createElement("option");
  optOneshot.value = "oneshot";
  optOneshot.textContent = "Одноразовый эффект";
  typeSelect.append(optLoop, optOneshot);

  const loopLabel = el("label", "checkbox-label");
  const loopCheckbox = document.createElement("input");
  loopCheckbox.type = "checkbox";
  loopCheckbox.checked = true;
  loopLabel.append(loopCheckbox, document.createTextNode(" зацикливать проигрывание"));

  const submit = el("button", "small-btn", "Добавить");
  submit.addEventListener("click", async () => {
    if (!linkInput.value.trim()) {
      alert("Нужна ссылка на файл.");
      return;
    }
    await addStream(folder.id, {
      name: nameInput.value.trim(),
      icon: iconInput.value.trim(),
      link: linkInput.value.trim(),
      type: typeSelect.value,
      loop: loopCheckbox.checked,
    });
    nameInput.value = "";
    iconInput.value = "";
    linkInput.value = "";
    form.hidden = true;
  });

  typeSelect.addEventListener("change", () => {
    loopLabel.hidden = typeSelect.value !== "loop";
  });

  form.append(nameInput, iconInput, linkInput, typeSelect, loopLabel, submit);
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });

  box.append(toggle, form);
  return box;
}

function renderAddFolderForm() {
  const box = el("div", "add-form add-folder-form");
  const toggle = el("button", "add-toggle", "+ новая папка");
  const form = el("div", "add-form-body");
  form.hidden = true;

  const nameInput = el("input", "text-input");
  nameInput.placeholder = "Название папки";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#6b5b95";
  colorInput.className = "color-input";

  const submit = el("button", "small-btn", "Создать");
  submit.addEventListener("click", async () => {
    if (!nameInput.value.trim()) return;
    await addFolder({ name: nameInput.value.trim(), color: colorInput.value });
    nameInput.value = "";
    form.hidden = true;
  });

  form.append(nameInput, colorInput, submit);
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
  });
  box.append(toggle, form);
  return box;
}

function renderAll() {
  root.innerHTML = "";
  for (const folder of effectiveFolders) root.appendChild(renderFolder(folder));
  if (editMode) root.appendChild(renderAddFolderForm());
}

function refreshUiFromState() {
  for (const row of root.querySelectorAll(".stream-row")) {
    if (!row._playBtn) continue;
    const streamId = row.dataset.streamId;
    const state = roomState.streams?.[streamId];
    row._playBtn.textContent = state?.playing ? "⏸" : "▶";
    row._playBtn.classList.toggle("is-playing", !!state?.playing);
    if (document.activeElement !== row._volume) {
      row._volume.value = String(state?.volume ?? row._volume.value);
    }
  }
}

function renderLocalControls() {
  const bar = document.getElementById("local-controls");
  bar.innerHTML = "";

  const muteBtn = el("button", "icon-btn", localMuted ? "🔇" : "🔊");
  muteBtn.addEventListener("click", () => {
    localMuted = !localMuted;
    writeLocal("muted", localMuted);
    muteBtn.textContent = localMuted ? "🔇" : "🔊";
    syncAll();
  });

  const vol = el("input", "vol");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.value = String(Math.round(localMasterVolume * 100));
  vol.title = "Твоя личная громкость (не синхронизируется)";
  vol.addEventListener("input", () => {
    localMasterVolume = clamp01(Number(vol.value) / 100);
    writeLocal("masterVolume", localMasterVolume);
    syncAll();
  });

  const roleTag = el("span", "role-tag", role === "GM" ? "мастер" : "игрок");

  bar.append(roleTag, muteBtn, vol);
}

editToggleBtn.addEventListener("click", () => {
  editMode = !editMode;
  editToggleBtn.classList.toggle("is-active", editMode);
  renderAll();
  refreshUiFromState();
});

// ---------- инициализация ----------

OBR.onReady(async () => {
  role = await OBR.player.getRole();
  editToggleBtn.hidden = role !== "GM";

  const initialMeta = await OBR.room.getMetadata();
  library = initialMeta[LIB_KEY] || library;
  roomState = initialMeta[STATE_KEY] || { streams: {} };
  computeEffectiveFolders();

  renderAll();
  renderLocalControls();
  refreshUiFromState();
  syncAll();

  OBR.room.onMetadataChange((metadata) => {
    const nextLibrary = metadata[LIB_KEY] || { hidden: [], overrides: {}, customStreams: {}, customFolders: [] };
    const libraryChanged = JSON.stringify(nextLibrary) !== JSON.stringify(library);
    library = nextLibrary;
    roomState = metadata[STATE_KEY] || { streams: {} };
    if (libraryChanged) {
      computeEffectiveFolders();
      renderAll();
    }
    refreshUiFromState();
    syncAll();
  });

  OBR.broadcast.onMessage(SFX_CHANNEL, (event) => {
    const { link, volume } = event.data || {};
    if (typeof link === "string") playSfxLocally(link, volume ?? 80);
  });

  setInterval(syncAll, 5000);

  if (!audioUnlocked) showUnlockOverlay();
});
