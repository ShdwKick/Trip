#!/usr/bin/env node
/**
 * Куда поедем? — backend совместного планирования поездок.
 * Чистый Node.js, без внешних зависимостей и без npm install
 * (SQLite — встроенный модуль node:sqlite, ставить нечего).
 *
 * Аккаунтов здесь нет: вход живёт в общем auth-сервисе (auth.burninghouse.ru),
 * сюда приходит подписанный access-токен, подпись которого проверяется ЛОКАЛЬНО
 * по JWKS. Сетевого запроса в auth на каждый вызов нет, и его недоступность не
 * мешает работать с уже выданными токенами. См. Auth/INTEGRATION.md.
 *
 * Запуск:            node server.js
 * Список поездок:    node server.js trips
 *
 * Переменные окружения:
 *   PORT           (по умолчанию 8790)      — порт
 *   HOST           (по умолчанию 127.0.0.1) — интерфейс (за nginx оставляем localhost)
 *   DATA_DIR       (по умолчанию ./data)    — store.db и каталог photos/
 *   AUTH_ISSUER    ОБЯЗАТЕЛЬНО — адрес auth-сервиса, напр. https://auth.burninghouse.ru.
 *                  Он же claim iss внутри токенов: сверяется побайтово.
 *   AUTH_CLIENT_ID (по умолчанию trip)      — идентификатор сервиса в auth
 *   AUTH_BASE      (по умолчанию = AUTH_ISSUER) — куда фронт уводит на вход. Отличается
 *                  от ISSUER только если сервер ходит в auth по внутреннему адресу.
 *   AUTH_JWKS_URL  (по умолчанию AUTH_ISSUER + /.well-known/jwks.json)
 *   AUTH_CLOCK_SKEW (по умолчанию 30) — допуск на расхождение часов, секунды
 *   MAX_PHOTO_BYTES (по умолчанию 4194304) — предел на одно фото после сжатия в браузере
 *   RESOLVE_SHORT_LINKS (по умолчанию 1) — разворачивать короткие ссылки карт
 *                  (maps.app.goo.gl и т.п.). Хождение в сеть строго по списку хостов.
 *   ALLOWED_ORIGIN — источник, которому разрешён доступ к /api/* (CORS). Нужен, только
 *                  если фронтенд отдаётся отдельно от этого сервера (сейчас не так).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = parseInt(process.env.PORT || "8790", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const DB_PATH = path.join(DATA_DIR, "store.db");
const APP_HTML = path.join(__dirname, "index.html");
const ASSETS_DIR = path.join(__dirname, "assets");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const MAX_PHOTO_BYTES = parseInt(process.env.MAX_PHOTO_BYTES || String(4 * 1024 * 1024), 10);
const RESOLVE_SHORT_LINKS = process.env.RESOLVE_SHORT_LINKS !== "0";

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "trip";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");

// ───────────────────────── хранилище ─────────────────────────
fs.mkdirSync(PHOTO_DIR, { recursive: true }); // создаёт и DATA_DIR заодно

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");   // конкурентные чтения не блокируют запись
db.exec("PRAGMA foreign_keys = ON");    // удаление поездки уносит места и фото
db.exec(`
  CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    destination TEXT,
    description TEXT,
    starts_on   TEXT,                       -- YYYY-MM-DD, может быть пустой
    ends_on     TEXT,
    currency    TEXT NOT NULL DEFAULT 'RUB',
    status      TEXT NOT NULL DEFAULT 'planning',   -- planning | active | done
    join_code   TEXT UNIQUE,                -- NULL = вход по ссылке закрыт
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Участие. Своей таблицы пользователей у сервиса нет и быть не должно:
  -- ключ — стабильный user_id из токена, остальное лежит рядом только чтобы
  -- показывать подпись в интерфейсе и предлагать перевод.
  -- name и phone добавляются миграцией ниже (таблица старше их) — как и у мест,
  -- объявление держим в одном месте, чтобы оно не разошлось.
  CREATE TABLE IF NOT EXISTS trip_members (
    trip_id   TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    username  TEXT,
    role      TEXT NOT NULL DEFAULT 'member',   -- owner | member
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (trip_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON trip_members(user_id);

  -- Место = пункт чек-листа. Поля именованные, а не общий JSON: по ним считают
  -- смету, строят маршрут и раскладывают по дням — в блобе это всё пришлось бы
  -- разбирать на каждый запрос.
  -- paid_by и split добавляются миграцией ниже (таблица старше их), поэтому
  -- здесь их нет: держать объявление в двух местах — верный способ разойтись.
  CREATE TABLE IF NOT EXISTS places (
    id            TEXT PRIMARY KEY,
    trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'spot',  -- stay|food|transport|sight|spot
    note          TEXT,
    address       TEXT,
    map_url       TEXT,
    lat           REAL,
    lon           REAL,
    link_url      TEXT,                          -- бронь, сайт, билеты
    day           TEXT,                          -- YYYY-MM-DD, пусто = «не запланировано»
    time_from     TEXT,                          -- HH:MM
    time_to       TEXT,
    cost_amount   REAL,
    cost_currency TEXT,
    cost_per      TEXT,                          -- total | person
    done          INTEGER NOT NULL DEFAULT 0,
    done_by       TEXT,
    done_at       INTEGER,
    sort_order    REAL NOT NULL DEFAULT 0,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_places_trip ON places(trip_id);

  -- Сами файлы лежат в DATA_DIR/photos, в базе только метаданные: SQLite с
  -- мегабайтными блобами пухнет и перестаёт помещаться в кэш страниц.
  CREATE TABLE IF NOT EXISTS photos (
    id          TEXT PRIMARY KEY,
    trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    place_id    TEXT REFERENCES places(id) ON DELETE CASCADE,
    file        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    caption     TEXT,
    uploaded_by TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_trip  ON photos(trip_id);
  CREATE INDEX IF NOT EXISTS idx_photos_place ON photos(place_id);

  -- Доли по счёту, когда «поровну» не подходит: общий счёт в ресторане, где
  -- каждый ел на своё. Хранятся явно и только для split='custom' — при
  -- «поровну» доли считаются от текущего состава, чтобы новый попутчик
  -- автоматически попадал в уже заведённые счета.
  CREATE TABLE IF NOT EXISTS place_shares (
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    amount   REAL NOT NULL,
    PRIMARY KEY (place_id, user_id)
  );

  -- Позиции чека. Появились ради самого частого спора в поездке: общий счёт в
  -- ресторане, где каждый ел своё, а чайник брали на троих. Позицию «берут» те,
  -- кто её заказывал, и её цена делится между ними — а не поровну на всех.
  CREATE TABLE IF NOT EXISTS place_items (
    id         TEXT PRIMARY KEY,
    place_id   TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    amount     REAL NOT NULL,          -- цена позиции целиком, уже с учётом количества
    qty        REAL,                   -- количество, если разобрали из чека; только для показа
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_place ON place_items(place_id);

  -- Кто взял позицию. Пусто — позицию никто не разобрал, тогда она делится на
  -- всех: молча повесить её на плательщика было бы несправедливо.
  CREATE TABLE IF NOT EXISTS place_item_users (
    item_id TEXT NOT NULL REFERENCES place_items(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (item_id, user_id)
  );

  -- Переводы между участниками. Статус операции в банке нам недоступен, поэтому
  -- запись — это заявление «я перевёл», а подтверждение получателя — отдельное
  -- поле. Пока не подтверждено, долг считается закрытым, но помечен ожидающим:
  -- иначе человек, который уже перевёл, снова видел бы себя должником.
  CREATE TABLE IF NOT EXISTS settlements (
    id           TEXT PRIMARY KEY,
    trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_user    TEXT NOT NULL,
    to_user      TEXT NOT NULL,
    amount       REAL NOT NULL,
    note         TEXT,
    created_at   INTEGER NOT NULL,
    confirmed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_settlements_trip ON settlements(trip_id);
`);

// Колонки, появившиеся позже своих таблиц: базы, созданные раньше, о них не
// знают, а CREATE TABLE IF NOT EXISTS их не тронет.
for (const sql of [
  "ALTER TABLE trip_members ADD COLUMN name TEXT",         // необязательное имя из auth
  "ALTER TABLE trip_members ADD COLUMN phone TEXT",        // номер для перевода, если разрешён
  "ALTER TABLE places ADD COLUMN paid_by TEXT",            // кто заплатил по счёту
  "ALTER TABLE places ADD COLUMN split TEXT NOT NULL DEFAULT 'equal'",  // equal | custom
]) {
  try { db.exec(sql); } catch { /* уже есть */ }
}

const stmt = {
  // Ссылку на базу держим здесь намеренно. После инициализации `db` больше нигде
  // не упоминается, и V8 вправе выбросить переменную из контекста модуля — тогда
  // финализатор DatabaseSync закроет базу, и все подготовленные запросы начнут
  // падать с «statement has been finalized». Через stmt база остаётся достижимой.
  db,

  tripsOfUser: db.prepare(`
    SELECT t.*, m.role AS my_role,
           (SELECT COUNT(*) FROM trip_members  x WHERE x.trip_id = t.id) AS members,
           (SELECT COUNT(*) FROM places        p WHERE p.trip_id = t.id) AS places,
           (SELECT COUNT(*) FROM places        p WHERE p.trip_id = t.id AND p.done = 1) AS places_done,
           (SELECT COUNT(*) FROM photos        f WHERE f.trip_id = t.id) AS photos
      FROM trips t JOIN trip_members m ON m.trip_id = t.id
     WHERE m.user_id = ?
     ORDER BY COALESCE(t.starts_on, '9999') ASC, t.created_at DESC`),
  trip:        db.prepare("SELECT * FROM trips WHERE id = ?"),
  tripByCode:  db.prepare("SELECT * FROM trips WHERE join_code = ?"),
  insertTrip:  db.prepare(`INSERT INTO trips
      (id,title,destination,description,starts_on,ends_on,currency,status,join_code,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  touchTrip:   db.prepare("UPDATE trips SET updated_at = ? WHERE id = ?"),
  deleteTrip:  db.prepare("DELETE FROM trips WHERE id = ?"),
  setCode:     db.prepare("UPDATE trips SET join_code = ?, updated_at = ? WHERE id = ?"),

  member:      db.prepare("SELECT * FROM trip_members WHERE trip_id = ? AND user_id = ?"),
  members:     db.prepare("SELECT user_id, username, name, phone, role, joined_at FROM trip_members WHERE trip_id = ? ORDER BY joined_at"),
  addMember:   db.prepare("INSERT INTO trip_members (trip_id,user_id,username,name,phone,role,joined_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(trip_id,user_id) DO UPDATE SET username = excluded.username, name = excluded.name, phone = excluded.phone"),
  dropMember:  db.prepare("DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?"),
  countOwners: db.prepare("SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ? AND role = 'owner'"),

  places:      db.prepare("SELECT * FROM places WHERE trip_id = ? ORDER BY sort_order, created_at"),
  place:       db.prepare("SELECT * FROM places WHERE id = ?"),
  insertPlace: db.prepare(`INSERT INTO places
      (id,trip_id,title,kind,note,address,map_url,lat,lon,link_url,day,time_from,time_to,
       cost_amount,cost_currency,cost_per,paid_by,split,done,done_by,done_at,sort_order,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  deletePlace: db.prepare("DELETE FROM places WHERE id = ?"),
  maxOrder:    db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM places WHERE trip_id = ?"),
  setOrder:    db.prepare("UPDATE places SET sort_order = ?, updated_at = ? WHERE id = ? AND trip_id = ?"),

  sharesOfTrip: db.prepare(`SELECT s.place_id, s.user_id, s.amount FROM place_shares s
      JOIN places p ON p.id = s.place_id WHERE p.trip_id = ?`),
  clearShares:  db.prepare("DELETE FROM place_shares WHERE place_id = ?"),
  addShare:     db.prepare("INSERT INTO place_shares (place_id, user_id, amount) VALUES (?,?,?) ON CONFLICT(place_id,user_id) DO UPDATE SET amount = excluded.amount"),

  itemsOfTrip:  db.prepare(`SELECT i.* FROM place_items i JOIN places p ON p.id = i.place_id
      WHERE p.trip_id = ? ORDER BY i.sort_order, i.created_at`),
  itemUsersOfTrip: db.prepare(`SELECT u.item_id, u.user_id FROM place_item_users u
      JOIN place_items i ON i.id = u.item_id JOIN places p ON p.id = i.place_id WHERE p.trip_id = ?`),
  item:         db.prepare("SELECT * FROM place_items WHERE id = ?"),
  itemsOfPlace: db.prepare("SELECT * FROM place_items WHERE place_id = ? ORDER BY sort_order, created_at"),
  addItem:      db.prepare("INSERT INTO place_items (id,place_id,title,amount,qty,sort_order,created_at) VALUES (?,?,?,?,?,?,?)"),
  updateItem:   db.prepare("UPDATE place_items SET title = ?, amount = ? WHERE id = ?"),
  dropItem:     db.prepare("DELETE FROM place_items WHERE id = ?"),
  maxItemOrder: db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM place_items WHERE place_id = ?"),
  itemUsers:    db.prepare("SELECT user_id FROM place_item_users WHERE item_id = ?"),
  clearItemUsers: db.prepare("DELETE FROM place_item_users WHERE item_id = ?"),
  addItemUser:  db.prepare("INSERT INTO place_item_users (item_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING"),
  dropItemUser: db.prepare("DELETE FROM place_item_users WHERE item_id = ? AND user_id = ?"),
  sumItems:     db.prepare("SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM place_items WHERE place_id = ?"),

  settlements:  db.prepare("SELECT * FROM settlements WHERE trip_id = ? ORDER BY created_at"),
  settlement:   db.prepare("SELECT * FROM settlements WHERE id = ?"),
  addSettlement: db.prepare("INSERT INTO settlements (id,trip_id,from_user,to_user,amount,note,created_at,confirmed_at) VALUES (?,?,?,?,?,?,?,?)"),
  confirmSettlement: db.prepare("UPDATE settlements SET confirmed_at = ? WHERE id = ?"),
  dropSettlement: db.prepare("DELETE FROM settlements WHERE id = ?"),

  photosOfTrip: db.prepare("SELECT id, place_id, mime, bytes, caption, uploaded_by, created_at FROM photos WHERE trip_id = ? ORDER BY created_at"),
  photo:        db.prepare("SELECT * FROM photos WHERE id = ?"),
  insertPhoto:  db.prepare("INSERT INTO photos (id,trip_id,place_id,file,mime,bytes,caption,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)"),
  deletePhoto:  db.prepare("DELETE FROM photos WHERE id = ?"),
  countPhotos:  db.prepare("SELECT COUNT(*) AS n FROM photos WHERE trip_id = ?"),

  listTrips:    db.prepare(`SELECT t.id, t.title, t.starts_on, t.updated_at,
      (SELECT COUNT(*) FROM trip_members m WHERE m.trip_id = t.id) AS members,
      (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) AS places
      FROM trips t ORDER BY t.updated_at DESC`),
};

// Обновление полей поездки/места собирается динамически: колонок много, и
// перечислять их в двадцати отдельных UPDATE — верный способ разойтись со схемой.
function updateRow(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...keys.map(k => fields[k]), id);
}

// ───────────────────────── мелкие утилиты ─────────────────────────
const now = () => Date.now();
const uid = () => crypto.randomUUID();

/** Код приглашения: без похожих друг на друга символов — его диктуют голосом. */
function newJoinCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  return code;
}

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
const num = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const oneOf = (v, list) => (list.includes(v) ? v : null);

// «activity» убран из списка: у мест, заведённых раньше, значение в базе
// осталось и показывается как «Разное» — переписывать чужие строки ради
// косметики не стоит.
const KINDS = ["stay", "food", "transport", "sight", "spot"];
const STATUSES = ["planning", "active", "done"];

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { tooLarge: true })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req, limit = 256 * 1024) => JSON.parse((await readBody(req, limit)).toString("utf8") || "{}");

// ───────────────────────── координаты из ссылок на карты ─────────────────────────
/**
 * Порядок координат у сервисов разный, и это главный источник ошибок: у Яндекса
 * в `ll`/`pt` идёт «долгота,широта», а в `rtext` — «широта,долгота»; у Google
 * везде «широта,долгота». Поэтому каждый источник разбирается своей веткой, а
 * общая проверка внизу ловит остаток (широты больше 90 не бывает).
 */
function point(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Единственная эвристика: если широта вне диапазона, а долгота в него влезает,
  // значит пара пришла перевёрнутой. Молча ошибиться местом — хуже, чем не понять ссылку.
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}
const pairOf = (s, order) => {
  const m = String(s || "").match(/(-?\d{1,3}(?:\.\d+)?)\s*[,%2C]+\s*(-?\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  return order === "latlon" ? point(+m[1], +m[2]) : point(+m[2], +m[1]);
};

function parseGeo(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  // Просто пара чисел, скопированная из карточки места.
  const bare = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (bare) return point(+bare[1], +bare[2]);

  let u;
  try { u = new URL(s.startsWith("http") ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const q = u.searchParams;
  const href = u.href;

  if (/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/.test(host)) {
    // whatshere[point] и pt/ll — «долгота,широта»
    for (const key of ["whatshere[point]", "pt", "ll"]) {
      const hit = pairOf(q.get(key), "lonlat");
      if (hit) return hit;
    }
    const rt = pairOf((q.get("rtext") || "").split("~").pop(), "latlon"); // конец маршрута — это и есть место
    if (rt) return rt;
  }
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === "maps.app.goo.gl" || host === "goo.gl") {
    const at = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);        // /@lat,lon,17z
    if (at) return point(+at[1], +at[2]);
    const d34 = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);   // внутренний формат ссылки на карточку
    if (d34) return point(+d34[1], +d34[2]);
    for (const key of ["q", "query", "ll", "center", "daddr", "destination"]) {
      const hit = pairOf(q.get(key), "latlon");
      if (hit) return hit;
    }
  }
  if (/(^|\.)2gis\.[a-z.]+$/.test(host) || host === "go.2gis.com") {
    for (const key of ["m", "queryState"]) {
      const hit = pairOf(q.get(key), "lonlat");
      if (hit) return hit;
    }
    const geo = u.pathname.match(/(-?\d{1,3}\.\d+)%2C(-?\d{1,3}\.\d+)|(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i);
    if (geo) return pairOf(geo[0], "lonlat");
  }
  if (/(^|\.)(openstreetmap\.org|osm\.org)$/.test(host)) {
    const mlat = point(+q.get("mlat"), +q.get("mlon"));
    if (mlat) return mlat;
    const m = u.hash.match(/map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (m) return point(+m[1], +m[2]);
  }
  if (host === "maps.apple.com") {
    for (const key of ["ll", "sll", "q", "daddr"]) {
      const hit = pairOf(q.get(key), "latlon");
      if (hit) return hit;
    }
  }
  // Незнакомый сервис: последняя попытка — координаты где-нибудь в адресе.
  const any = href.match(/(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/);
  return any ? point(+any[1], +any[2]) : null;
}

/**
 * Короткие ссылки (maps.app.goo.gl/…, yandex.ru/maps/-/…) координат не содержат
 * вовсе — они только редиректят. Разворачиваем их сами, но строго по списку
 * хостов и не читая тело ответа: сервер, который ходит по любому присланному
 * адресу, — это SSRF, а из докера видно и соседние контейнеры, и метаданные
 * хостинга. Список закрывает и вход, и каждый шаг редиректа.
 */
const LINK_HOSTS = new Set([
  "maps.app.goo.gl", "goo.gl", "google.com", "www.google.com", "maps.google.com",
  "yandex.ru", "www.yandex.ru", "yandex.com", "ya.ru", "maps.yandex.ru",
  "go.2gis.com", "2gis.ru", "2gis.com",
  "osm.org", "www.osm.org", "openstreetmap.org", "www.openstreetmap.org",
  "maps.apple.com",
]);
const hostAllowed = url => { try { return LINK_HOSTS.has(new URL(url).hostname); } catch { return false; } };

async function resolveMapLink(raw) {
  const direct = parseGeo(raw);
  if (direct) return { ...direct, resolvedFrom: null };
  if (!RESOLVE_SHORT_LINKS || !hostAllowed(raw)) return null;

  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    let res;
    try {
      res = await fetch(url, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": "BurningHouse-Trip/1.0" } });
    } catch { clearTimeout(timer); return null; }
    clearTimeout(timer);
    res.body?.cancel().catch(() => {}); // тело нам не нужно — только заголовок Location
    const next = res.headers.get("location");
    if (!next) return null;
    url = new URL(next, url).href;
    if (!hostAllowed(url)) return null;
    const hit = parseGeo(url);
    if (hit) return { ...hit, resolvedFrom: url };
  }
  return null;
}

// ───────────────────────── CLI ─────────────────────────
const [, , cmd] = process.argv;
if (cmd === "trips") {
  const rows = stmt.listTrips.all();
  if (!rows.length) console.log("(пусто)");
  for (const r of rows) {
    console.log(`${(r.title || "—").slice(0, 28).padEnd(30)} ${r.id}  ${(r.starts_on || "без дат").padEnd(10)}  участников: ${r.members}, мест: ${r.places}`);
  }
  process.exit(0);
}
if (cmd) {
  console.error(`Неизвестная команда: ${cmd}\n\nДоступно: trips\nАккаунтами заведует auth-сервис — см. там adduser/passwd/users.`);
  process.exit(1);
}

// ───────────────────────── авторизация ─────────────────────────
if (!AUTH_ISSUER) {
  console.error("Не задан AUTH_ISSUER — без него нечем проверять токены. Укажите адрес auth-сервиса, напр. AUTH_ISSUER=https://auth.burninghouse.ru");
  process.exit(1);
}
const auth = require("./auth-client")({
  issuer: AUTH_ISSUER,
  audience: AUTH_CLIENT_ID,
  jwksUrl: process.env.AUTH_JWKS_URL,
  clockSkew: process.env.AUTH_CLOCK_SKEW == null ? undefined : parseInt(process.env.AUTH_CLOCK_SKEW, 10),
});
auth.warmup(); // прогреть кэш ключей, чтобы первый запрос не ждал сеть

/** Участие пользователя в поездке. Единственная точка проверки доступа. */
function access(tripId, user) {
  const trip = stmt.trip.get(tripId);
  if (!trip) return null;
  const member = stmt.member.get(tripId, user.id);
  if (!member) return null;
  // Раз пользователь пришёл — заодно освежаем логин, имя и телефон: всё это
  // живёт в auth и могло измениться там, а показывается отсюда. Имя и телефон
  // ещё и включаются-выключаются пользователем, поэтому сверяем в обе стороны:
  // выключил показ — копия обязана исчезнуть, а не остаться навсегда.
  if ((user.username && member.username !== user.username)
      || (user.name || null) !== (member.name || null)
      || (user.phone || null) !== (member.phone || null)) {
    stmt.addMember.run(tripId, user.id, user.username, user.name || null, user.phone || null, member.role, member.joined_at);
    member.username = user.username;
    member.name = user.name || null;
    member.phone = user.phone || null;
  }
  return { trip, member, isOwner: member.role === "owner" };
}

// ───────────────────────── сборка ответов ─────────────────────────
function tripPayload(trip, me) {
  const places = stmt.places.all(trip.id);
  const photos = stmt.photosOfTrip.all(trip.id);
  const byPlace = new Map();
  for (const ph of photos) {
    const key = ph.place_id || "";
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push({ id: ph.id, mime: ph.mime, bytes: ph.bytes, caption: ph.caption, uploadedBy: ph.uploaded_by, createdAt: ph.created_at });
  }
  const sharesOf = new Map();
  for (const s of stmt.sharesOfTrip.all(trip.id)) {
    if (!sharesOf.has(s.place_id)) sharesOf.set(s.place_id, []);
    sharesOf.get(s.place_id).push({ userId: s.user_id, amount: s.amount });
  }
  const itemUsers = new Map();
  for (const u of stmt.itemUsersOfTrip.all(trip.id)) {
    if (!itemUsers.has(u.item_id)) itemUsers.set(u.item_id, []);
    itemUsers.get(u.item_id).push(u.user_id);
  }
  const itemsOf = new Map();
  for (const it of stmt.itemsOfTrip.all(trip.id)) {
    if (!itemsOf.has(it.place_id)) itemsOf.set(it.place_id, []);
    itemsOf.get(it.place_id).push({
      id: it.id, title: it.title, amount: it.amount, qty: it.qty,
      users: itemUsers.get(it.id) || [], sortOrder: it.sort_order,
    });
  }
  return {
    trip: {
      id: trip.id, title: trip.title, destination: trip.destination, description: trip.description,
      startsOn: trip.starts_on, endsOn: trip.ends_on, currency: trip.currency, status: trip.status,
      joinCode: trip.join_code, createdBy: trip.created_by, createdAt: trip.created_at, updatedAt: trip.updated_at,
      myRole: me.role,
    },
    // Телефон отдаём только внутри поездки — это группа, которую собрал сам
    // человек. В превью приглашения (его видит любой со ссылкой) номеров нет.
    members: stmt.members.all(trip.id).map(m => ({
      userId: m.user_id, username: m.username, name: m.name, phone: m.phone,
      role: m.role, joinedAt: m.joined_at,
    })),
    places: places.map(p => ({
      id: p.id, title: p.title, kind: p.kind, note: p.note, address: p.address,
      mapUrl: p.map_url, lat: p.lat, lon: p.lon, linkUrl: p.link_url,
      day: p.day, timeFrom: p.time_from, timeTo: p.time_to,
      costAmount: p.cost_amount, costCurrency: p.cost_currency, costPer: p.cost_per,
      paidBy: p.paid_by, split: p.split || "equal", shares: sharesOf.get(p.id) || [],
      items: itemsOf.get(p.id) || [],
      done: !!p.done, doneBy: p.done_by, doneAt: p.done_at,
      sortOrder: p.sort_order, createdBy: p.created_by, updatedAt: p.updated_at,
      photos: byPlace.get(p.id) || [],
    })),
    tripPhotos: byPlace.get("") || [],
    settlements: stmt.settlements.all(trip.id).map(s => ({
      id: s.id, fromUser: s.from_user, toUser: s.to_user, amount: s.amount,
      note: s.note, createdAt: s.created_at, confirmedAt: s.confirmed_at,
    })),
  };
}

/**
 * Доли по счёту. Пишутся целиком: присланный список — это и есть новое
 * состояние. Частичное обновление здесь означало бы, что доля исчезнувшего из
 * списка человека молча остаётся висеть.
 *
 * Чужие user_id отбрасываем: доля не участника поездки в своде долгов
 * превратилась бы в долг призрака, которого не видно в составе.
 */
function writeShares(placeId, tripId, shares) {
  if (shares === undefined) return;
  stmt.clearShares.run(placeId);
  if (!Array.isArray(shares)) return;
  const members = new Set(stmt.members.all(tripId).map(m => m.user_id));
  for (const s of shares.slice(0, 100)) {
    const userId = String(s?.userId || "");
    const amount = num(s?.amount);
    if (!members.has(userId) || amount === null) continue;
    stmt.addShare.run(placeId, userId, Math.max(0, Math.round(amount * 100) / 100));
  }
}

const round2 = v => Math.round(v * 100) / 100;

/**
 * Позиции — источник правды для суммы места: пока они есть, цена места равна их
 * сумме. Иначе смета считалась бы по одной цифре, а «моя доля» — по другой, и
 * расхождение всплыло бы только при расчёте, когда спорить уже поздно.
 * Чаевые и обслуживание заводят такой же позицией.
 */
function syncCostFromItems(placeId) {
  const place = stmt.place.get(placeId);
  if (!place) return;
  const { total, n } = stmt.sumItems.get(placeId);
  if (n) updateRow("places", placeId, { cost_amount: round2(total), cost_per: "total", split: "items", updated_at: now() });
  else if (place.split === "items") updateRow("places", placeId, { split: "equal", updated_at: now() });
}

/** Кто взял позицию. Чужие user_id отбрасываем — как и в долях. */
function writeItemUsers(itemId, tripId, users) {
  if (!Array.isArray(users)) return;
  stmt.clearItemUsers.run(itemId);
  const members = new Set(stmt.members.all(tripId).map(m => m.user_id));
  for (const id of users.slice(0, 50)) if (members.has(String(id))) stmt.addItemUser.run(itemId, String(id));
}

/** Поля места из тела запроса. Пришло только то, что редактировали, — остальное не трогаем. */
function placeFields(body, currency, tripId) {
  const out = {};
  const put = (key, value) => { if (value !== undefined) out[key] = value; };

  if ("title" in body)    out.title = str(body.title, 200) || "Без названия";
  if ("kind" in body)     put("kind", oneOf(body.kind, KINDS) || "spot");
  if ("note" in body)     out.note = str(body.note, 4000);
  if ("address" in body)  out.address = str(body.address, 400);
  if ("linkUrl" in body)  out.link_url = str(body.linkUrl, 1000);
  if ("day" in body)      out.day = isDate(body.day) ? body.day : null;
  if ("timeFrom" in body) out.time_from = isTime(body.timeFrom) ? body.timeFrom : null;
  if ("timeTo" in body)   out.time_to = isTime(body.timeTo) ? body.timeTo : null;
  if ("costAmount" in body) {
    const amount = num(body.costAmount);
    out.cost_amount = amount === null ? null : Math.max(0, amount);
    if (out.cost_amount !== null && !("costCurrency" in body)) out.cost_currency = currency;
  }
  if ("costCurrency" in body) out.cost_currency = str(body.costCurrency, 8);
  if ("costPer" in body)      out.cost_per = oneOf(body.costPer, ["total", "person"]) || "total";
  if ("mapUrl" in body)       out.map_url = str(body.mapUrl, 2000);
  if ("split" in body)        out.split = oneOf(body.split, ["equal", "custom", "items"]) || "equal";
  if ("paidBy" in body) {
    // Плательщиком может быть только участник поездки: иначе в своде долгов
    // появился бы кредитор, которого в составе нет и которому нельзя перевести.
    const id = str(body.paidBy, 64);
    out.paid_by = id && stmt.member.get(tripId, id) ? id : null;
  }
  // Координаты приходят разобранными с фронта (там же, где показывается результат),
  // но проверяем их ещё раз здесь: фронт — не граница доверия.
  if ("lat" in body || "lon" in body) {
    const p = point(num(body.lat), num(body.lon));
    out.lat = p ? p.lat : null;
    out.lon = p ? p.lon : null;
  }
  return out;
}

// ───────────────────────── HTTP ─────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};
const PHOTO_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/** Отдаём только index.html и assets/. store.db, server.js и photos/ снаружи недоступны. */
function serveStatic(res, pathname) {
  if (pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  if (file !== APP_HTML && !file.startsWith(ASSETS_DIR + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}
function serveApp(res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(APP_HTML));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html не найден рядом с server.js");
  }
}

/** Тип файла определяем по сигнатуре, а не по присланному Content-Type. */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (ALLOWED_ORIGIN && p.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  }

  try {
    if (p === "/api/health") return json(res, 200, { ok: true });
    // Адрес auth отдаём с сервера, чтобы он не был зашит в статику и менялся
    // одной переменной окружения.
    if (p === "/api/config") return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID, maxPhotoBytes: MAX_PHOTO_BYTES });

    if (p.startsWith("/api/")) {
      // Вся авторизация — вот эти две строки. Подпись проверяется локально,
      // запроса в auth-сервис здесь не происходит.
      const user = await auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: "unauthorized" });
      return await api(req, res, url, user);
    }

    if (req.method === "GET") {
      if (p !== "/" && serveStatic(res, p)) return;
      return serveApp(res);   // остальное — SPA с маршрутизацией по хэшу
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (e && e.tooLarge) return json(res, 413, { error: "too large" });
    console.error("Ошибка обработки запроса:", e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

async function api(req, res, url, user) {
  const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const m = req.method;

  // ── список поездок и создание ───────────────────────────────
  if (seg.length === 2 && seg[1] === "trips") {
    if (m === "GET") {
      const rows = stmt.tripsOfUser.all(user.id);
      return json(res, 200, {
        me: { id: user.id, username: user.username, name: user.name || null },
        trips: rows.map(t => ({
          id: t.id, title: t.title, destination: t.destination, startsOn: t.starts_on, endsOn: t.ends_on,
          currency: t.currency, status: t.status, myRole: t.my_role,
          members: t.members, places: t.places, placesDone: t.places_done, photos: t.photos,
          updatedAt: t.updated_at,
        })),
      });
    }
    if (m === "POST") {
      const body = await readJson(req);
      const id = uid(), ts = now();
      stmt.insertTrip.run(
        id,
        str(body.title, 200) || "Новая поездка",
        str(body.destination, 200),
        str(body.description, 4000),
        isDate(body.startsOn) ? body.startsOn : null,
        isDate(body.endsOn) ? body.endsOn : null,
        str(body.currency, 8) || "RUB",
        oneOf(body.status, STATUSES) || "planning",
        newJoinCode(),
        user.id, ts, ts,
      );
      stmt.addMember.run(id, user.id, user.username || null, user.name || null, user.phone || null, "owner", ts);
      return json(res, 200, tripPayload(stmt.trip.get(id), { role: "owner" }));
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── приглашение по коду ─────────────────────────────────────
  if (seg[1] === "invite" && seg[2]) {
    const code = String(seg[2]).toUpperCase().slice(0, 16);
    const trip = stmt.tripByCode.get(code);
    if (!trip) return json(res, 404, { error: "no such invite" });
    const already = stmt.member.get(trip.id, user.id);

    if (m === "GET") {
      return json(res, 200, {
        tripId: trip.id, title: trip.title, destination: trip.destination,
        startsOn: trip.starts_on, endsOn: trip.ends_on,
        // Показываем имя, если человек включил его показ, иначе логин.
        members: stmt.members.all(trip.id).map(x => x.name || x.username).filter(Boolean),
        alreadyMember: !!already,
      });
    }
    if (m === "POST") {
      if (!already) stmt.addMember.run(trip.id, user.id, user.username || null, user.name || null, user.phone || null, "member", now());
      return json(res, 200, { tripId: trip.id, joined: !already });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── одна поездка ────────────────────────────────────────────
  if (seg[1] === "trips" && seg[2]) {
    const tripId = seg[2];
    const ctx = access(tripId, user);
    if (!ctx) return json(res, 404, { error: "not found" });   // 404, а не 403: чужая поездка не должна даже подтверждаться
    const tail = seg.slice(3);

    if (!tail.length) {
      if (m === "GET") return json(res, 200, tripPayload(ctx.trip, ctx.member));
      if (m === "PATCH") {
        const body = await readJson(req);
        const f = {};
        if ("title" in body)       f.title = str(body.title, 200) || ctx.trip.title;
        if ("destination" in body) f.destination = str(body.destination, 200);
        if ("description" in body) f.description = str(body.description, 4000);
        if ("startsOn" in body)    f.starts_on = isDate(body.startsOn) ? body.startsOn : null;
        if ("endsOn" in body)      f.ends_on = isDate(body.endsOn) ? body.endsOn : null;
        if ("currency" in body)    f.currency = str(body.currency, 8) || "RUB";
        if ("status" in body)      f.status = oneOf(body.status, STATUSES) || ctx.trip.status;
        f.updated_at = now();
        updateRow("trips", tripId, f);
        return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
      }
      if (m === "DELETE") {
        // Удалять может только владелец: для остальных есть «выйти из поездки».
        if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
        for (const ph of stmt.photosOfTrip.all(tripId)) dropPhotoFile(stmt.photo.get(ph.id));
        stmt.deleteTrip.run(tripId);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // приглашение: перевыпустить или закрыть
    if (tail[0] === "code") {
      if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
      if (m === "POST")   { const code = newJoinCode(); stmt.setCode.run(code, now(), tripId); return json(res, 200, { joinCode: code }); }
      if (m === "DELETE") { stmt.setCode.run(null, now(), tripId); return json(res, 200, { joinCode: null }); }
      return json(res, 405, { error: "method not allowed" });
    }

    if (tail[0] === "leave" && m === "POST") {
      // Последний владелец уйти не может — иначе поездка останется без хозяина
      // и её будет некому ни удалить, ни переименовать.
      if (ctx.isOwner && stmt.countOwners.get(tripId).n <= 1) {
        return json(res, 409, { error: "last owner", message: "Вы единственный владелец: передайте поездку или удалите её." });
      }
      stmt.dropMember.run(tripId, user.id);
      return json(res, 200, { ok: true });
    }

    if (tail[0] === "members" && tail[1]) {
      if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
      if (m === "DELETE") {
        if (tail[1] === user.id) return json(res, 409, { error: "self", message: "Себя убрать нельзя — используйте «выйти»." });
        stmt.dropMember.run(tripId, tail[1]);
        return json(res, 200, { ok: true });
      }
      if (m === "PATCH") {
        const body = await readJson(req);
        const role = oneOf(body.role, ["owner", "member"]);
        if (!role) return json(res, 400, { error: "bad role" });
        const target = stmt.member.get(tripId, tail[1]);
        if (!target) return json(res, 404, { error: "no such member" });
        stmt.addMember.run(tripId, target.user_id, target.username, target.name || null, target.phone || null, role, target.joined_at);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // места
    if (tail[0] === "places") {
      // Порядок веток важен: и создание, и перестановка — это POST на /places,
      // и общая ветка перехватила бы /places/reorder, молча заводя новое место.
      if (tail[1] === "reorder" && m === "POST") {
        const body = await readJson(req);
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
        const ts = now();
        // Порядок задаётся целиком присланным списком: частичные сдвиги «вверх на
        // единицу» разъезжаются, когда двое двигают карточки одновременно.
        ids.forEach((id, i) => stmt.setOrder.run(i + 1, ts, String(id), tripId));
        stmt.touchTrip.run(ts, tripId);
        return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
      }
      if (m === "POST") {
        const body = await readJson(req);
        const id = uid(), ts = now();
        const f = placeFields(body, ctx.trip.currency, tripId);
        stmt.insertPlace.run(
          id, tripId, f.title || "Новое место", f.kind || "spot", f.note ?? null, f.address ?? null,
          f.map_url ?? null, f.lat ?? null, f.lon ?? null, f.link_url ?? null,
          f.day ?? null, f.time_from ?? null, f.time_to ?? null,
          f.cost_amount ?? null, f.cost_currency ?? null, f.cost_per ?? "total",
          f.paid_by ?? null, f.split ?? "equal",
          0, null, null,
          stmt.maxOrder.get(tripId).m + 1,
          user.id, ts, ts,
        );
        writeShares(id, tripId, body.shares);
        stmt.touchTrip.run(ts, tripId);
        return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // переводы между участниками
    if (tail[0] === "settlements" && m === "POST") {
      const body = await readJson(req);
      const toUser = str(body.toUser, 64);
      const amount = num(body.amount);
      if (!toUser || !stmt.member.get(tripId, toUser)) return json(res, 400, { error: "no such member" });
      if (toUser === user.id) return json(res, 400, { error: "self", message: "Перевод самому себе ничего не меняет." });
      if (amount === null || amount <= 0) return json(res, 400, { error: "bad amount" });
      // Запись создаёт только отправитель и только от своего имени: это
      // заявление «я перевёл», а не бухгалтерская проводка за другого.
      stmt.addSettlement.run(uid(), tripId, user.id, toUser, Math.round(amount * 100) / 100,
        str(body.note, 200), now(), null);
      stmt.touchTrip.run(now(), tripId);
      return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
    }

    // фото поездки целиком (без привязки к месту) — тем же обработчиком, что и у места
    if (tail[0] === "photos" && m === "POST") {
      return await uploadPhoto(req, res, ctx, user, null, url);
    }

    return json(res, 404, { error: "not found" });
  }

  // ── одно место ──────────────────────────────────────────────
  if (seg[1] === "places" && seg[2]) {
    const place = stmt.place.get(seg[2]);
    if (!place) return json(res, 404, { error: "not found" });
    const ctx = access(place.trip_id, user);
    if (!ctx) return json(res, 404, { error: "not found" });
    const tail = seg.slice(3);

    if (!tail.length) {
      if (m === "PATCH") {
        const body = await readJson(req);
        const f = placeFields(body, ctx.trip.currency, ctx.trip.id);
        if ("done" in body) {
          f.done = body.done ? 1 : 0;
          f.done_by = body.done ? user.id : null;
          f.done_at = body.done ? now() : null;
        }
        f.updated_at = now();
        updateRow("places", place.id, f);
        writeShares(place.id, ctx.trip.id, body.shares);
        stmt.touchTrip.run(f.updated_at, ctx.trip.id);
        return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
      }
      if (m === "DELETE") {
        for (const ph of stmt.photosOfTrip.all(ctx.trip.id)) {
          if (ph.place_id === place.id) dropPhotoFile(stmt.photo.get(ph.id));
        }
        stmt.deletePlace.run(place.id);
        stmt.touchTrip.run(now(), ctx.trip.id);
        return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (tail[0] === "photos" && m === "POST") {
      return await uploadPhoto(req, res, ctx, user, place.id, url);
    }
    // Позиции чека приходят пачкой: разбирают вставленный текст на фронте, а
    // сюда отправляют уже разобранный список — по одной штуке это была бы
    // очередь из двадцати запросов.
    if (tail[0] === "items" && m === "POST") {
      const body = await readJson(req, 512 * 1024);
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      let order = stmt.maxItemOrder.get(place.id).m;
      const ts = now();
      for (const raw of items) {
        const title = str(raw?.title, 200);
        const amount = num(raw?.amount);
        if (!title || amount === null) continue;
        const id = uid();
        stmt.addItem.run(id, place.id, title, Math.max(0, round2(amount)), num(raw?.qty), ++order, ts);
        writeItemUsers(id, ctx.trip.id, raw?.users);
      }
      syncCostFromItems(place.id);
      stmt.touchTrip.run(ts, ctx.trip.id);
      return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
    }
    return json(res, 404, { error: "not found" });
  }

  // ── позиция чека ────────────────────────────────────────────
  if (seg[1] === "items" && seg[2]) {
    const item = stmt.item.get(seg[2]);
    if (!item) return json(res, 404, { error: "not found" });
    const place = stmt.place.get(item.place_id);
    const ctx = place && access(place.trip_id, user);
    if (!ctx) return json(res, 404, { error: "not found" });

    if (seg[3] === "take" && m === "POST") {
      // Отметить «это моё» может каждый и только за себя: чужую тарелку
      // приписывать некому.
      const mine = stmt.itemUsers.all(item.id).some(u => u.user_id === user.id);
      if (mine) stmt.dropItemUser.run(item.id, user.id);
      else stmt.addItemUser.run(item.id, user.id);
      stmt.touchTrip.run(now(), ctx.trip.id);
      return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
    }
    if (!seg[3] && m === "PATCH") {
      const body = await readJson(req);
      const title = "title" in body ? (str(body.title, 200) || item.title) : item.title;
      const amount = "amount" in body ? Math.max(0, round2(num(body.amount) ?? item.amount)) : item.amount;
      stmt.updateItem.run(title, amount, item.id);
      if ("users" in body) writeItemUsers(item.id, ctx.trip.id, body.users);
      syncCostFromItems(place.id);
      stmt.touchTrip.run(now(), ctx.trip.id);
      return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
    }
    if (!seg[3] && m === "DELETE") {
      stmt.dropItem.run(item.id);
      syncCostFromItems(place.id);
      stmt.touchTrip.run(now(), ctx.trip.id);
      return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── перевод: подтверждение и отмена ─────────────────────────
  if (seg[1] === "settlements" && seg[2]) {
    const s = stmt.settlement.get(seg[2]);
    if (!s) return json(res, 404, { error: "not found" });
    const ctx = access(s.trip_id, user);
    if (!ctx) return json(res, 404, { error: "not found" });

    if (seg[3] === "confirm" && m === "POST") {
      // Подтверждает только получатель: «деньги пришли» — единственное, что он
      // знает достоверно, и единственное, чего не знает сервис.
      if (s.to_user !== user.id) return json(res, 403, { error: "not yours", message: "Подтвердить получение может только получатель." });
      stmt.confirmSettlement.run(now(), s.id);
      return json(res, 200, tripPayload(stmt.trip.get(s.trip_id), ctx.member));
    }
    if (!seg[3] && m === "DELETE") {
      // Удалить может любая из двух сторон: отправитель — если ошибся, получатель —
      // если денег так и не увидел.
      if (s.from_user !== user.id && s.to_user !== user.id) return json(res, 403, { error: "not yours" });
      stmt.dropSettlement.run(s.id);
      return json(res, 200, tripPayload(stmt.trip.get(s.trip_id), ctx.member));
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── фото ────────────────────────────────────────────────────
  if (seg[1] === "photos" && seg[2]) {
    const ph = stmt.photo.get(seg[2]);
    if (!ph) return json(res, 404, { error: "not found" });
    const ctx = access(ph.trip_id, user);
    if (!ctx) return json(res, 404, { error: "not found" });

    if (m === "GET") {
      const file = path.join(PHOTO_DIR, ph.file);
      if (!fs.existsSync(file)) return json(res, 404, { error: "file missing" });
      res.writeHead(200, {
        "Content-Type": ph.mime,
        "Content-Length": ph.bytes,
        // private: файл ушёл по токену, промежуточным кэшам его держать нельзя.
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (m === "DELETE") {
      // Своё фото убирает автор, чужое — владелец поездки.
      if (ph.uploaded_by !== user.id && !ctx.isOwner) return json(res, 403, { error: "not yours" });
      dropPhotoFile(ph);
      stmt.deletePhoto.run(ph.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── координаты из ссылки ────────────────────────────────────
  if (seg[1] === "maplink" && m === "POST") {
    const body = await readJson(req, 8 * 1024);
    const hit = await resolveMapLink(String(body.url || "").slice(0, 2000));
    return json(res, 200, hit ? { found: true, ...hit } : { found: false });
  }

  return json(res, 404, { error: "not found" });
}

async function uploadPhoto(req, res, ctx, user, placeId, url) {
  const buf = await readBody(req, MAX_PHOTO_BYTES);
  const mime = sniffImage(buf);
  if (!mime) return json(res, 415, { error: "not an image", message: "Поддерживаются JPEG, PNG и WebP." });

  const id = uid();
  const file = id + PHOTO_MIME[mime];
  fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
  stmt.insertPhoto.run(id, ctx.trip.id, placeId, file, mime, buf.length,
    str(url.searchParams.get("caption"), 200), user.id, now());
  stmt.touchTrip.run(now(), ctx.trip.id);
  return json(res, 200, { photo: { id, placeId, mime, bytes: buf.length } });
}

/** Файл убираем отдельно от строки: каскад в SQLite про диск ничего не знает. */
function dropPhotoFile(ph) {
  if (!ph) return;
  try { fs.unlinkSync(path.join(PHOTO_DIR, ph.file)); } catch { /* уже нет — и хорошо */ }
}

server.listen(PORT, HOST, () => {
  console.log(`«Куда поедем?» — http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
});
