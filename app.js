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

// Важно: не "lib/index.js" напрямую — внутри пакета относительные импорты без
// расширения ".js" (нормально для сборщиков вроде Vite/Webpack, но браузер
// при загрузке модуля напрямую с CDN такое не резолвит и всё падает в 404).
// "+esm" — отдельный режим jsDelivr, который сам собирает пакет в один
// файл со всеми зависимостями (uuid, immer, js-base64) уже склеенными.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
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
  // Для <audio> Dropbox должен отдавать файл как содержимое для браузера,
  // а не как принудительное скачивание. `dl=1` задаёт download-режим,
  // `raw=1` — прямой render/raw-режим, который корректнее для media element.
  try {
    const url = new URL(link);
    if (url.hostname === "dropbox.com" || url.hostname.endsWith(".dropbox.com")) {
      url.searchParams.delete("dl");
      url.searchParams.set("raw", "1");
      return url.toString();
    }
  } catch {
    // Если это невалидный URL, оставляем как есть — обработчик audio.error
    // покажет проблему в консоли.
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
  if (!o) return { ...stream, id };
  const merged = { ...stream, id, ...o };
  // "link" не настоящее поле стрима — это правка ссылки первого трека,
  // храним её отдельно от overrides, а здесь просто подставляем на лету.
  if (o.link) {
    merged.tracks = [
      { ...(stream.tracks[0] || {}), link: o.link, loop: o.loop ?? stream.tracks[0]?.loop },
    ];
  }
  delete merged.link;
  return merged;
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

// Затухание — только на клиенте, только между "проценты базовой громкости"
// (0–100), и applyVolume всё равно клэмпит каждый кадр. Именно так не
// повторяем баг DJinni: там громкость на HTMLMediaElement.volume ставилась
// напрямую и могла уйти за пределы [0,1] — здесь физически невозможно.
const fadeAnimations = new Map(); // streamId -> {cancelled}
const lastPlayingState = new Map(); // streamId -> boolean

function cancelFade(streamId) {
  const anim = fadeAnimations.get(streamId);
  if (anim) anim.cancelled = true;
  fadeAnimations.delete(streamId);
}

function fadeVolume(el, streamId, fromPercent, toPercent, durationMs, onDone) {
  cancelFade(streamId);
  if (!durationMs || durationMs <= 0) {
    applyVolume(el, toPercent);
    onDone?.();
    return;
  }
  const token = { cancelled: false };
  fadeAnimations.set(streamId, token);
  const start = performance.now();
  function step(now) {
    if (token.cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    applyVolume(el, fromPercent + (toPercent - fromPercent) * t);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      fadeAnimations.delete(streamId);
      onDone?.();
    }
  }
  requestAnimationFrame(step);
}

function syncStream(streamId) {
  const entry = STREAM_INDEX.get(streamId);
  if (!entry || entry.stream.type !== "loop") return;
  const { stream } = entry;
  const state = roomState.streams?.[streamId];
  const el = getOrCreateAudio(streamId);
  const wasPlaying = lastPlayingState.get(streamId) ?? false;
  const targetVolume = state?.volume ?? stream.volume ?? 80;
  const fadeMs = Math.max(0, Number(stream.fadeMs) || 0);

  if (!state || !state.playing) {
    if (wasPlaying && !el.paused) {
      fadeVolume(el, streamId, targetVolume, 0, fadeMs, () => el.pause());
    } else if (!el.paused) {
      el.pause();
    }
    lastPlayingState.set(streamId, false);
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

  // Раньше здесь было "if (!audioUnlocked) return" — то есть пока игрок не
  // кликнет отдельный оверлей "включить звук", код даже не ПЫТАЛСЯ вызвать
  // el.play() для музыки/эмбиента, только выставлял громкость. Из-за этого
  // музыка и эмбиент у игроков не звучали никогда, если они этот оверлей не
  // заметили или не нажали, — а звуковая панель (oneshot, playSfxLocally)
  // такой проверки не имела вообще и просто пробовала play() напрямую,
  // поэтому у игроков работала. Теперь ведём себя одинаково для обоих:
  // всегда пробуем play(), оверлей показываем только если браузер реально
  // отклонил воспроизведение (см. .catch ниже), а не превентивно.

  const startedAt = typeof state.startedAt === "number" ? state.startedAt : Date.now();
  const elapsedSec = Math.max(0, (Date.now() - startedAt) / 1000);
  const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  const target = el.loop && duration ? elapsedSec % duration : elapsedSec;
  const justStarted = !wasPlaying;

  if (el.paused) {
    try {
      el.currentTime = target;
    } catch {
      /* метаданные ещё не загружены — play() подождёт сам */
    }
    applyVolume(el, justStarted && fadeMs > 0 ? 0 : targetVolume);
    el.play()
      .then(() => {
        // Раз play() реально прошёл — звук у этого клиента точно разрешён
        // браузером, оверлей больше не нужен (даже если он его не нажимал).
        audioUnlocked = true;
        hideUnlockOverlay();
        if (justStarted && fadeMs > 0) fadeVolume(el, streamId, 0, targetVolume, fadeMs);
      })
      .catch((err) => {
        console.warn("[Ravenloft Music] play() отклонён браузером", err);
        showUnlockOverlay();
      });
  } else {
    if (!fadeAnimations.has(streamId)) applyVolume(el, targetVolume);
    if (duration && Math.abs(el.currentTime - target) > 1.5) {
      try {
        el.currentTime = target;
      } catch {
        /* ignore */
      }
    }
  }

  lastPlayingState.set(streamId, true);
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

async function addStream(folderId, { name, icon, link, type, loop, fadeMs }) {
  const id = freshId("c");
  const stream = {
    id,
    name: name || "Без названия",
    icon: icon || (type === "oneshot" ? "🔊" : "🎵"),
    volume: 80,
    type,
    loop: type === "loop" ? !!loop : undefined,
    fadeMs: type === "loop" ? Math.max(0, Number(fadeMs) || 0) : 0,
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
const nowPlayingRoot = document.getElementById("now-playing");
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

  const linkInput = el("input", "text-input");
  linkInput.placeholder = "Ссылка";
  linkInput.value = stream.tracks[0]?.link || "";

  box.append(nameInput, iconInput, linkInput);

  let loopCheckbox;
  let fadeInput;
  if (stream.type === "loop") {
    const loopLabel = el("label", "checkbox-label");
    loopCheckbox = document.createElement("input");
    loopCheckbox.type = "checkbox";
    loopCheckbox.checked = !!stream.loop;
    loopLabel.append(loopCheckbox, document.createTextNode(" зациклен"));
    box.appendChild(loopLabel);

    fadeInput = el("input", "text-input fade-input");
    fadeInput.type = "number";
    fadeInput.min = "0";
    fadeInput.step = "500";
    fadeInput.placeholder = "Затухание, мс";
    fadeInput.value = String(stream.fadeMs || 0);
    box.appendChild(fadeInput);
  }

  const save = el("button", "small-btn", "Сохранить");
  save.addEventListener("click", async () => {
    const patch = { name: nameInput.value.trim() || stream.name, icon: iconInput.value.trim() };
    const newLink = linkInput.value.trim();
    if (newLink && newLink !== stream.tracks[0]?.link) patch.link = newLink;
    if (loopCheckbox) patch.loop = loopCheckbox.checked;
    if (fadeInput) patch.fadeMs = Math.max(0, Number(fadeInput.value) || 0);
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

  const fadeInput = el("input", "text-input fade-input");
  fadeInput.type = "number";
  fadeInput.min = "0";
  fadeInput.step = "500";
  fadeInput.placeholder = "Затухание, мс (0 = без него)";

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
      fadeMs: fadeInput.value,
    });
    nameInput.value = "";
    iconInput.value = "";
    linkInput.value = "";
    fadeInput.value = "";
    form.hidden = true;
  });

  typeSelect.addEventListener("change", () => {
    loopLabel.hidden = typeSelect.value !== "loop";
    fadeInput.hidden = typeSelect.value !== "loop";
  });

  form.append(nameInput, iconInput, linkInput, typeSelect, loopLabel, fadeInput, submit);
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
  renderNowPlaying();
}

// Отдельная панель "сейчас играет" — быстрый доступ ко всему, что реально
// звучит прямо сейчас, без необходимости разворачивать дерево папок.
// Строки обновляются на месте (не пересоздаются), иначе перетаскивание
// ползунка громкости прерывалось бы собственным же эхо через onMetadataChange.
const nowPlayingRows = new Map(); // streamId -> {row, volume, nameEl}

function renderNowPlaying() {
  if (!nowPlayingRoot) return;

  const playingIds = new Set();
  const playingEntries = [];
  for (const [, entry] of STREAM_INDEX) {
    if (entry.stream.type !== "loop") continue;
    if (roomState.streams?.[entry.stream.id]?.playing) {
      playingIds.add(entry.stream.id);
      playingEntries.push(entry);
    }
  }

  for (const [id, refs] of nowPlayingRows) {
    if (!playingIds.has(id)) {
      refs.row.remove();
      nowPlayingRows.delete(id);
    }
  }

  if (playingEntries.length === 0) {
    if (!nowPlayingRoot.querySelector(".now-playing-empty")) {
      nowPlayingRoot.innerHTML = "";
      nowPlayingRoot.appendChild(el("div", "now-playing-empty", "Сейчас тихо"));
    }
    return;
  }
  nowPlayingRoot.querySelector(".now-playing-empty")?.remove();

  for (const { folder, stream } of playingEntries) {
    const state = roomState.streams?.[stream.id];
    let refs = nowPlayingRows.get(stream.id);
    if (!refs) {
      const row = el("div", "now-playing-row");
      const top = el("div", "now-playing-top");
      top.appendChild(el("span", "now-playing-folder", folder.name));
      row.appendChild(top);
      const nameEl = el("div", "now-playing-name");
      row.appendChild(nameEl);

      const controls = el("div", "now-playing-controls");
      const stopBtn = el("button", "play-btn is-playing", "⏸");
      stopBtn.disabled = role !== "GM";
      stopBtn.addEventListener("click", () => toggleStream(stream.id));
      const volume = el("input", "vol");
      volume.type = "range";
      volume.min = "0";
      volume.max = "100";
      volume.disabled = role !== "GM";
      volume.addEventListener("input", () => setStreamVolume(stream.id, Number(volume.value)));
      controls.append(stopBtn, volume);
      row.appendChild(controls);

      nowPlayingRoot.appendChild(row);
      refs = { row, volume, nameEl };
      nowPlayingRows.set(stream.id, refs);
    }
    refs.nameEl.textContent = `${stream.icon || ""} ${stream.name}`;
    if (document.activeElement !== refs.volume) {
      refs.volume.value = String(state?.volume ?? stream.volume ?? 80);
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

