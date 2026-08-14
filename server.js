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
 *   PUBLIC_URL     — свой адрес сервиса, напр. https://trip.burninghouse.ru. Без него
 *                  напоминания на почту выключены целиком: письму некуда вести ссылкой.
 *   RESEND_API_KEY, MAIL_FROM — отправка почты, см. mailer.js. Без ключа письма
 *                  просто печатаются в консоль вместо отправки (как и в Auth).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { checkAdminKey, createAdminLog } = require("./admin-internal");
const mailer = require("./mailer");
const mailTpl = require("./emailTemplates");

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

// Распознавание чека. Без ключа сервис работает как раньше — просто без кнопки
// съёмки: ключ есть не у всех, кто поднимет этот код у себя.
const GIGACHAT_AUTH_KEY = process.env.GIGACHAT_AUTH_KEY || "";
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
const GIGACHAT_MODEL = process.env.GIGACHAT_MODEL || "GigaChat-2-Pro";

// Напоминания на почту про сборы. PUBLIC_URL — свой адрес сервиса (нужен, чтобы
// собрать в письме ссылку на поездку: сервер её не знает, в отличие от фронта,
// который берёт location.origin). Без него собрать рабочую ссылку не из чего,
// поэтому вся возможность выключена целиком, как и распознавание чека без ключа.
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const REMINDERS_ENABLED = !!PUBLIC_URL;
const REMIND_OFFSETS = { week: 7 * 86400e3, "3d": 3 * 86400e3, "1d": 86400e3, "3h": 3 * 3600e3, "1h": 3600e3 };
const REMIND_LABELS = { week: "за неделю", "3d": "за 3 дня", "1d": "за день", "3h": "за 3 часа", "1h": "за час" };
const REMIND_CHECK_MS = 5 * 60 * 1000;
// Настраиваемо ради тестов: e2e дёргает проверку сама через /internal/reminders/check
// и хочет знать точно, сколько писем ушло именно от её вызова — не долю секунды раньше.
const REMIND_INITIAL_DELAY_MS = parseInt(process.env.REMIND_INITIAL_DELAY_MS || "5000", 10);

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

  -- Что взять с собой. Список общий на поездку — договорились один раз, что
  -- нужны переходник и аптечка, — а вот галочки у каждого свои: паспорт
  -- собирает себе каждый, и «Маша отметила паспорт» ничего не говорит о вашем.
  -- Этим список вещей и отличается от списка мест, где отметка общая.
  CREATE TABLE IF NOT EXISTS packing_items (
    id         TEXT PRIMARY KEY,
    trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    note       TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_packing_trip ON packing_items(trip_id);

  -- Отметка «сложил» — своя у каждого. Нет строки — не сложил.
  CREATE TABLE IF NOT EXISTS packing_checks (
    item_id  TEXT NOT NULL REFERENCES packing_items(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, user_id)
  );

  -- Напоминание на почту про конкретную вещь — тоже личное, как и «сложил»:
  -- каждый решает сам, про что ему напомнить и за сколько. Срок отсчитывается
  -- от даты начала поездки (trips.starts_on), поэтому без даты напоминание
  -- поставить нельзя — сервер это проверяет при записи.
  CREATE TABLE IF NOT EXISTS packing_reminders (
    item_id     TEXT NOT NULL REFERENCES packing_items(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    offset_code TEXT NOT NULL,   -- week | 3d | 1d | 3h | 1h — см. REMIND_OFFSETS
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER,         -- NULL, пока не отправлено
    PRIMARY KEY (item_id, user_id)
  );
`);

// Колонки, появившиеся позже своих таблиц: базы, созданные раньше, о них не
// знают, а CREATE TABLE IF NOT EXISTS их не тронет.
for (const sql of [
  "ALTER TABLE trip_members ADD COLUMN name TEXT",         // необязательное имя из auth
  "ALTER TABLE trip_members ADD COLUMN phone TEXT",        // номер для перевода, если разрешён
  // Почта — только чтобы прислать НАПОМИНАНИЕ САМОМУ ВЛАДЕЛЬЦУ. Другим
  // участникам не показывается нигде (в отличие от phone, у неё нет своей
  // ручки согласия — она приходит в токене всегда, если вообще есть на
  // аккаунте), поэтому и в tripPayload её нет: раскрывать лишнее незачем.
  "ALTER TABLE trip_members ADD COLUMN email TEXT",
  "ALTER TABLE places ADD COLUMN paid_by TEXT",            // кто заплатил по счёту
  "ALTER TABLE places ADD COLUMN split TEXT NOT NULL DEFAULT 'equal'",  // equal | custom
  "ALTER TABLE place_items ADD COLUMN guest TEXT",         // «Гость 1» из чека, если он так разбит
]) {
  try { db.exec(sql); } catch { /* уже есть */ }
}

// Лог для Admin (см. admin-internal.js) — своя таблица поверх той же базы.
const adminLog = createAdminLog(db);

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
  addMember:   db.prepare("INSERT INTO trip_members (trip_id,user_id,username,name,phone,email,role,joined_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(trip_id,user_id) DO UPDATE SET username = excluded.username, name = excluded.name, phone = excluded.phone, email = excluded.email"),
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
  addItem:      db.prepare("INSERT INTO place_items (id,place_id,title,amount,qty,guest,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)"),
  updateItem:   db.prepare("UPDATE place_items SET title = ?, amount = ? WHERE id = ?"),
  dropItem:     db.prepare("DELETE FROM place_items WHERE id = ?"),
  maxItemOrder: db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM place_items WHERE place_id = ?"),
  itemUsers:    db.prepare("SELECT user_id FROM place_item_users WHERE item_id = ?"),
  clearItemUsers: db.prepare("DELETE FROM place_item_users WHERE item_id = ?"),
  addItemUser:  db.prepare("INSERT INTO place_item_users (item_id, user_id) VALUES (?,?) ON CONFLICT DO NOTHING"),
  dropItemUser: db.prepare("DELETE FROM place_item_users WHERE item_id = ? AND user_id = ?"),
  sumItems:     db.prepare("SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM place_items WHERE place_id = ?"),

  packing:       db.prepare("SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order, created_at"),
  packingItem:   db.prepare("SELECT * FROM packing_items WHERE id = ?"),
  insertPacking: db.prepare("INSERT INTO packing_items (id,trip_id,title,note,sort_order,created_by,created_at) VALUES (?,?,?,?,?,?,?)"),
  deletePacking: db.prepare("DELETE FROM packing_items WHERE id = ?"),
  maxPackOrder:  db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM packing_items WHERE trip_id = ?"),
  // Только свои отметки: чужие в ответ не попадают вовсе, а не отбрасываются на
  // клиенте — их там просто нечем показать.
  myPacked:      db.prepare(`SELECT c.item_id FROM packing_checks c
                               JOIN packing_items i ON i.id = c.item_id
                              WHERE i.trip_id = ? AND c.user_id = ?`),
  packCheck:     db.prepare("INSERT INTO packing_checks (item_id,user_id,added_at) VALUES (?,?,?) ON CONFLICT DO NOTHING"),
  packUncheck:   db.prepare("DELETE FROM packing_checks WHERE item_id = ? AND user_id = ?"),

  // Напоминания — тоже личные, тем же приёмом, что и отметки «сложил».
  myReminders:   db.prepare(`SELECT r.item_id, r.offset_code, r.sent_at FROM packing_reminders r
                               JOIN packing_items i ON i.id = r.item_id
                              WHERE i.trip_id = ? AND r.user_id = ?`),
  // Смена срока (offset_code) обязана снять старую отметку «отправлено»:
  // иначе более ранний срок, поставленный ПОСЛЕ уже отправленного письма,
  // никогда не сработает — фоновая проверка видит только sent_at IS NULL.
  setReminder:   db.prepare(`INSERT INTO packing_reminders (item_id,user_id,offset_code,created_at) VALUES (?,?,?,?)
                              ON CONFLICT(item_id,user_id) DO UPDATE SET offset_code = excluded.offset_code, sent_at = NULL`),
  dropReminder:  db.prepare("DELETE FROM packing_reminders WHERE item_id = ? AND user_id = ?"),
  // Всё, что пора отправить, — по всем поездкам сразу: фоновая проверка одна
  // на процесс, а не одна на поездку.
  dueReminders:  db.prepare(`
    SELECT r.item_id, r.user_id, r.offset_code, i.title AS item_title, t.id AS trip_id,
           t.title AS trip_title, t.starts_on, m.email
      FROM packing_reminders r
      JOIN packing_items i ON i.id = r.item_id
      JOIN trips t ON t.id = i.trip_id
      JOIN trip_members m ON m.trip_id = t.id AND m.user_id = r.user_id
     WHERE r.sent_at IS NULL AND t.starts_on IS NOT NULL`),
  markReminderSent: db.prepare("UPDATE packing_reminders SET sent_at = ? WHERE item_id = ? AND user_id = ?"),

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

const giga = require("./gigachat")({
  authKey: GIGACHAT_AUTH_KEY,
  scope: GIGACHAT_SCOPE,
  model: GIGACHAT_MODEL,
});
const { checkBill } = require("./gigachat");

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
      || (user.phone || null) !== (member.phone || null)
      || (user.email || null) !== (member.email || null)) {
    stmt.addMember.run(tripId, user.id, user.username, user.name || null, user.phone || null, user.email || null, member.role, member.joined_at);
    member.username = user.username;
    member.name = user.name || null;
    member.phone = user.phone || null;
    member.email = user.email || null;
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
  const packedByMe = new Set(stmt.myPacked.all(trip.id, me.user_id).map(r => r.item_id));
  const remindByMe = new Map(stmt.myReminders.all(trip.id, me.user_id).map(r => [r.item_id, { offset: r.offset_code, sent: !!r.sent_at }]));
  const itemsOf = new Map();
  for (const it of stmt.itemsOfTrip.all(trip.id)) {
    if (!itemsOf.has(it.place_id)) itemsOf.set(it.place_id, []);
    itemsOf.get(it.place_id).push({
      id: it.id, title: it.title, amount: it.amount, qty: it.qty, guest: it.guest,
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
    // Список вещей общий, отметка «сложил» — только ваша. Чужие сюда не
    // попадают: договорились, что каждый собирает свой рюкзак сам.
    packing: stmt.packing.all(trip.id).map(i => ({
      id: i.id, title: i.title, note: i.note, sortOrder: i.sort_order,
      createdBy: i.created_by, packed: packedByMe.has(i.id),
      remind: remindByMe.get(i.id) || null,
    })),
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

    // Для Admin: server-to-server по общему ключу (см. admin-internal.js), не SSO.
    if (p === "/internal/stats" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return json(res, 200, {
        ok: true,
        trips: db.prepare("SELECT COUNT(*) AS n FROM trips").get().n,
        places: db.prepare("SELECT COUNT(*) AS n FROM places").get().n,
        photos: db.prepare("SELECT COUNT(*) AS n FROM photos").get().n,
        settlements: db.prepare("SELECT COUNT(*) AS n FROM settlements").get().n,
        tripsCreated7d: db.prepare("SELECT COUNT(*) AS n FROM trips WHERE created_at > ?").get(since7d).n,
        placesCreated7d: db.prepare("SELECT COUNT(*) AS n FROM places WHERE created_at > ?").get(since7d).n,
      });
    }
    // Ручной прогон проверки напоминаний — не только для тестов: если процесс
    // долго живёт и по какой-то причине пропустил тики интервала, этим можно
    // подтолкнуть его руками, не перезапуская сервис.
    if (p === "/internal/reminders/check" && req.method === "POST") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      return json(res, 200, { ok: true, sent: checkReminders() });
    }
    if (p === "/internal/logs" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      return json(res, 200, {
        logs: adminLog.recent({ since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined }),
      });
    }

    // Список поездок для Admin. Название ручки — "rooms" (общее с Movies, где
    // это буквально комнаты): в обоих сервисах это один и тот же смысл — общая
    // группа с кодом приглашения, к которой присоединяются несколько человек,
    // только называется в каждом сервисе по-своему.
    if (p === "/internal/rooms" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const rows = db.prepare(`
        SELECT t.id, t.title, t.destination, t.status, t.join_code, t.created_at,
               (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) AS members,
               (SELECT COUNT(*) FROM places pl WHERE pl.trip_id = t.id) AS places
        FROM trips t
        ORDER BY t.created_at DESC
        LIMIT 200
      `).all();
      return json(res, 200, {
        rooms: rows.map(r => ({
          id: r.id, title: r.title, destination: r.destination || null, status: r.status,
          joinCode: r.join_code || null, membersCount: r.members, placesCount: r.places, createdAt: r.created_at,
        })),
      });
    }

    // Адрес auth отдаём с сервера, чтобы он не был зашит в статику и менялся
    // одной переменной окружения.
    if (p === "/api/config") return json(res, 200, {
      authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID, maxPhotoBytes: MAX_PHOTO_BYTES,
      scanReceipt: giga.enabled,   // без ключа кнопку съёмки не показываем вовсе
      // Без PUBLIC_URL письмо не собрать (ссылка внутри вести будет некуда),
      // поэтому саму галочку «напомнить» тогда не показываем вовсе.
      reminders: REMINDERS_ENABLED,
      remindOffsets: Object.keys(REMIND_OFFSETS).map(code => ({ code, label: REMIND_LABELS[code] })),
    });

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
    adminLog.error("Ошибка обработки запроса", { path: p, method: req.method, message: e.message });
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
      stmt.addMember.run(id, user.id, user.username || null, user.name || null, user.phone || null, user.email || null, "owner", ts);
      // Ответ собираем от лица создателя целиком, а не одной ролью: в нём есть
      // и то, что зависит от «кого именно» — например личные отметки в списке вещей.
      return json(res, 200, tripPayload(stmt.trip.get(id), stmt.member.get(id, user.id)));
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
      if (!already) stmt.addMember.run(trip.id, user.id, user.username || null, user.name || null, user.phone || null, user.email || null, "member", now());
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
        stmt.addMember.run(tripId, target.user_id, target.username, target.name || null, target.phone || null, target.email || null, role, target.joined_at);
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

    // что взять с собой
    if (tail[0] === "packing") {
      if (m === "POST" && !tail[1]) {
        const body = await readJson(req);
        const title = str(body.title, 200);
        if (!title) return json(res, 400, { error: "no title", message: "Напишите, что взять." });
        const ts = now();
        stmt.insertPacking.run(uid(), tripId, title, str(body.note, 500) || null,
          stmt.maxPackOrder.get(tripId).m + 1, user.id, ts);
        stmt.touchTrip.run(ts, tripId);
        return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
      }
      if (tail[1]) {
        const item = stmt.packingItem.get(tail[1]);
        if (!item || item.trip_id !== tripId) return json(res, 404, { error: "not found" });
        // Отметка «сложил» своя у каждого, поэтому её ставит и снимает любой
        // участник — но только себе: чужой user_id тут взять неоткуда.
        if (tail[2] === "packed" && m === "POST") {
          const body = await readJson(req);
          if (body.packed === false) stmt.packUncheck.run(item.id, user.id);
          else stmt.packCheck.run(item.id, user.id, now());
          return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
        }
        // Напоминание — тоже только себе. Требует и почту на аккаунте (некуда
        // слать), и дату начала поездки (не от чего отсчитывать срок) — без
        // них отбиваем понятной причиной, а не тихо игнорируем.
        if (tail[2] === "remind" && m === "POST") {
          if (!REMINDERS_ENABLED) return json(res, 400, { error: "disabled" });
          const body = await readJson(req);
          if (body.enabled === false) {
            stmt.dropReminder.run(item.id, user.id);
            return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
          }
          const offset = oneOf(body.offset, Object.keys(REMIND_OFFSETS));
          if (!offset) return json(res, 400, { error: "bad offset" });
          if (!user.email) return json(res, 400, { error: "no_email", message: "На аккаунте BurningHouse не указана почта — добавьте её в личном кабинете, иначе напоминанию некуда прийти." });
          if (!ctx.trip.starts_on) return json(res, 400, { error: "no_date", message: "У поездки не указана дата начала — не от чего отсчитывать срок." });
          stmt.setReminder.run(item.id, user.id, offset, now());
          return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
        }
        if (m === "PATCH") {
          const body = await readJson(req);
          const f = {};
          if ("title" in body) f.title = str(body.title, 200) || item.title;
          if ("note" in body)  f.note = str(body.note, 500) || null;
          updateRow("packing_items", item.id, f);
          stmt.touchTrip.run(now(), tripId);
          return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
        }
        // Строка общая, поэтому убрать её может любой участник: вещь оказалась
        // не нужна всем сразу, а не только тому, кто её вписал. Чужие отметки
        // уходят вместе с ней по внешнему ключу.
        if (m === "DELETE") {
          stmt.deletePacking.run(item.id);
          stmt.touchTrip.run(now(), tripId);
          return json(res, 200, tripPayload(stmt.trip.get(tripId), ctx.member));
        }
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
    // Распознать чек по фотографии. Снимок не сохраняем: он нужен на время
    // разбора, а хранить чужие счета с суммами незачем.
    if (tail[0] === "scan" && m === "POST") {
      if (!giga.enabled) return json(res, 503, { error: "not configured", message: "Распознавание чека не настроено." });
      const buf = await readBody(req, MAX_PHOTO_BYTES);
      const mime = sniffImage(buf);
      if (!mime) return json(res, 415, { error: "not an image", message: "Это не похоже на фотографию." });
      try {
        const { bill, usage } = await giga.readReceipt(buf, mime);
        const checked = checkBill(bill);
        // Расход пишем в лог: сколько стоит распознавание одного чека, из
        // тарифов не выведешь, а знать это нужно.
        console.log(`Чек распознан: позиций ${checked.items.length}, сумма ${checked.sum}, итог ${checked.total ?? "—"}` +
          `${checked.matches ? ", сходится" : `, расхождение ${checked.diff ?? "?"}`}` +
          `${usage ? `, токенов ${usage.total_tokens ?? "?"}` : ""}`);
        return json(res, 200, checked);
      } catch (e) {
        console.error("Распознавание чека не удалось:", e.message);
        return json(res, 502, { error: "scan failed", message: "Не удалось разобрать чек. Попробуйте снимок получше или впишите позиции руками." });
      }
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
        stmt.addItem.run(id, place.id, title, Math.max(0, round2(amount)), num(raw?.qty), str(raw?.guest, 40), ++order, ts);
        writeItemUsers(id, ctx.trip.id, raw?.users);
      }
      syncCostFromItems(place.id);
      stmt.touchTrip.run(ts, ctx.trip.id);
      return json(res, 200, tripPayload(stmt.trip.get(ctx.trip.id), ctx.member));
    }
    // Блок гостя из чека — это одна раздача позиций одному кругу людей:
    // «Гость 1» на чеке значит именно то, что все его строки заказал один и
    // тот же человек (или два человека, если делили). Поэтому у позиций
    // одного guest список users всегда общий, и назначать его удобнее одним
    // действием, а не по позиции — независимо от того, чем это назначение
    // сделано: галочкой «моё», списком людей или отдельной кнопкой «Это чьё-то».
    // Пишем атомарно одним запросом, а не циклом PATCH: посреди цикла разница
    // между «уже отправил половину» и «ничего не отправил» пользователю не видна.
    if (tail[0] === "items" && tail[1] === "guest" && m === "PATCH") {
      const body = await readJson(req);
      const guest = str(body.guest, 40);
      if (!guest) return json(res, 400, { error: "no guest" });
      const targets = stmt.itemsOfPlace.all(place.id).filter(i => i.guest === guest);
      if (!targets.length) return json(res, 404, { error: "no such guest" });
      for (const it of targets) writeItemUsers(it.id, ctx.trip.id, body.users);
      syncCostFromItems(place.id);   // сумма позиций не меняется, но так же делает соседний PATCH /items/:id
      stmt.touchTrip.run(now(), ctx.trip.id);
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

/**
 * Проверка напоминаний. Срок отсчитывается от полуночи даты начала поездки:
 * `starts_on` — это только дата («YYYY-MM-DD»), а `Date.parse` для такой
 * строки по спецификации даёт полночь UTC, одинаково на любом сервере —
 * не спорит с часовым поясом хоста и ничего не привязывает к нему.
 *
 * Своего расписания (cron, очередь) не заводим: сервис один процесс, значений
 * — десятки, простого интервала достаточно, а с очередью появился бы ещё один
 * компонент, который может не подняться.
 */
function checkReminders() {
  if (!REMINDERS_ENABLED) return 0;
  const nowMs = now();
  let sent = 0;
  for (const r of stmt.dueReminders.all()) {
    const offsetMs = REMIND_OFFSETS[r.offset_code];
    const startMs = Date.parse(r.starts_on);
    if (!offsetMs || !Number.isFinite(startMs)) continue;   // офсет из старой версии кода или дата битая — пропускаем
    if (nowMs < startMs - offsetMs) continue;                // ещё не время
    if (!r.email) continue;   // почту убрали с аккаунта уже после того, как поставили напоминание
    const mail = mailTpl.packingReminder({
      link: PUBLIC_URL + "/#/t/" + r.trip_id,
      tripTitle: r.trip_title, itemTitle: r.item_title, whenLabel: REMIND_LABELS[r.offset_code],
    });
    mailer.send({ to: r.email, subject: mail.subject, html: mail.html, text: mail.text });
    stmt.markReminderSent.run(nowMs, r.item_id, r.user_id);
    sent++;
  }
  return sent;
}
if (REMINDERS_ENABLED) {
  setTimeout(checkReminders, REMIND_INITIAL_DELAY_MS).unref();   // догнать просроченное вскоре после старта, не дожидаясь первого интервала
  setInterval(checkReminders, REMIND_CHECK_MS).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`«Куда поедем?» — http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_ISSUER} (клиент «${AUTH_CLIENT_ID}»)`);
});
