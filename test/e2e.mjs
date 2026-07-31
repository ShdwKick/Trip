/**
 * Сквозная проверка «Куда поедем?»: auth (8788) + trip (8790).
 * Поднимает оба сервиса сама и имитирует ровно то, что делает браузер: вход по
 * authorization code + PKCE, работу со списком мест, приглашение второго
 * человека по ссылке и загрузку фотографии.
 *
 * Запуск (Node 24; на Node 22 добавьте --experimental-sqlite):
 *   node test/e2e.mjs
 *
 * Порты 8788 и 8790 на время прогона должны быть свободны. Ожидает, что рядом
 * лежит репозиторий Auth — в ../Auth (или укажите AUTH_DIR).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const TRIP_DIR = path.resolve(fileURLToPath(import.meta.url), "../..");
const AUTH_DIR = process.env.AUTH_DIR || path.join(TRIP_DIR, "..", "Auth");
const WORK = path.join(TRIP_DIR, "test", ".work");
const AUTH = "http://localhost:8788";
const TRIP = "http://localhost:8790";
const NODE_ARGS = process.version.startsWith("v22") ? ["--experimental-sqlite"] : [];

if (!fs.existsSync(path.join(AUTH_DIR, "server.js"))) {
  console.error(`Не нашёл auth-сервис в ${AUTH_DIR}. Укажите путь через AUTH_DIR.`);
  process.exit(1);
}
for (const [url, port] of [[AUTH, 8788], [TRIP, 8790]]) {
  try {
    await fetch(url + "/api/health", { signal: AbortSignal.timeout(700) });
    console.error(`Порт ${port} уже занят — остановите тот сервис и повторите.`);
    process.exit(1);
  } catch { /* никого нет, продолжаем */ }
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK + "/auth", { recursive: true });
fs.mkdirSync(WORK + "/trip", { recursive: true });

let failures = 0;
function ok(name, cond, extra = "") {
  console.log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}
const b64u = b => Buffer.from(b).toString("base64url");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. Настройка auth ---------- */
const authEnv = { ...process.env, DATA_DIR: WORK + "/auth" };
const authCli = (...a) => execFileSync("node", [...NODE_ARGS, "server.js", ...a], { cwd: AUTH_DIR, env: authEnv, encoding: "utf8" });
authCli("client-add", "trip", "Куда поедем?", TRIP + "/");
authCli("adduser", "danil", "ПарольДляТеста-2026");
authCli("adduser", "sputnik", "ПарольПопутчика-2026");

/* ---------- 2. Запуск сервисов ---------- */
const procs = [];
function start(name, cwd, env) {
  const p = spawn("node", [...NODE_ARGS, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  p.stdout.on("data", d => log.push(String(d)));
  p.stderr.on("data", d => log.push(String(d)));
  procs.push({ name, p, log });
}
start("auth", AUTH_DIR, { ...authEnv, DEV: "1", ISSUER: AUTH, PORT: "8788", HOST: "127.0.0.1" });
start("trip", TRIP_DIR, {
  ...process.env, DATA_DIR: WORK + "/trip", PORT: "8790", HOST: "127.0.0.1",
  AUTH_ISSUER: AUTH, AUTH_CLIENT_ID: "trip",
  RESOLVE_SHORT_LINKS: "0",   // в тесте наружу не ходим
});

async function waitUp(url) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url + "/api/health")).ok) return true; } catch { }
    await sleep(200);
  }
  return false;
}
ok("auth поднялся", await waitUp(AUTH));
ok("trip поднялся", await waitUp(TRIP));

/* ---------- 3. Конфиг и закрытость без токена ---------- */
const cfg = await (await fetch(TRIP + "/api/config")).json();
ok("сервис отдаёт адрес auth", cfg.authBase === AUTH && cfg.clientId === "trip", JSON.stringify(cfg));
ok("/api/trips без токена → 401", (await fetch(TRIP + "/api/trips")).status === 401);

/* ---------- 4. Вход двух человек ---------- */
async function login(username, password) {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirect = TRIP + "/";
  const r = await fetch(`${AUTH}/api/authorize/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username, password, client_id: "trip", redirect_uri: redirect, state: "s",
      code_challenge: challenge, code_challenge_method: "S256",
    }),
  });
  const data = await r.json();
  if (!data.redirect) throw new Error(`вход не удался: ${JSON.stringify(data)}`);
  const code = new URL(data.redirect).searchParams.get("code");
  const t = await (await fetch(`${AUTH}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: "trip", redirect_uri: redirect, code, code_verifier: verifier }),
  })).json();
  return t;
}
const me = await login("danil", "ПарольДляТеста-2026");
const friend = await login("sputnik", "ПарольПопутчика-2026");
ok("оба вошли и получили токены", !!me.access_token && !!friend.access_token);

const call = (token, path, init = {}) => fetch(TRIP + "/api" + path, {
  ...init,
  headers: {
    Authorization: "Bearer " + token,
    ...(init.body && !init.raw ? { "Content-Type": "application/json" } : {}),
    ...init.headers,
  },
  body: init.raw ? init.body : init.body ? JSON.stringify(init.body) : undefined,
});
const asJson = async (...a) => {
  const r = await call(...a);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/* ---------- 5. Поездка ---------- */
let r = await asJson(me.access_token, "/trips", {
  method: "POST",
  body: { title: "Грузия на майские", destination: "Тбилиси", startsOn: "2026-05-01", endsOn: "2026-05-07", currency: "GEL" },
});
const tripId = r.body.trip?.id;
ok("поездка создана", r.status === 200 && !!tripId, r.body.error || "");
ok("создатель — владелец", r.body.trip?.myRole === "owner");
ok("код приглашения выдан сразу", !!r.body.trip?.joinCode);

r = await asJson(me.access_token, "/trips");
ok("поездка видна в списке", r.body.trips?.length === 1 && r.body.trips[0].id === tripId);
ok("логин попал в /trips", r.body.me?.username === "danil");

/* ---------- 6. Чужой доступ закрыт ---------- */
r = await asJson(friend.access_token, "/trips/" + tripId);
ok("посторонний не видит поездку (404, а не 403)", r.status === 404);
r = await asJson(friend.access_token, "/trips");
ok("у постороннего пустой список", r.body.trips?.length === 0);

/* ---------- 7. Места и координаты из ссылок ---------- */
const LINKS = [
  ["Яндекс ll (долгота,широта)", "https://yandex.ru/maps/?ll=44.783%2C41.693&z=16", 41.693, 44.783],
  ["Яндекс whatshere", "https://yandex.ru/maps/org/x/?whatshere%5Bpoint%5D=44.8015,41.7225&whatshere%5Bzoom%5D=17", 41.7225, 44.8015],
  ["Google @широта,долгота", "https://www.google.com/maps/@41.6934,44.8015,17z", 41.6934, 44.8015],
  ["Google q=", "https://maps.google.com/?q=41.7,44.8", 41.7, 44.8],
  ["2ГИС m=", "https://2gis.ru/tbilisi?m=44.8015%2C41.6934%2F17", 41.6934, 44.8015],
  ["OSM #map", "https://www.openstreetmap.org/#map=17/41.6934/44.8015", 41.6934, 44.8015],
  ["просто координаты", "41.6934, 44.8015", 41.6934, 44.8015],
];
for (const [name, url, lat, lon] of LINKS) {
  const res = await asJson(me.access_token, "/maplink", { method: "POST", body: { url } });
  ok(`ссылка разобрана: ${name}`, res.body.found && Math.abs(res.body.lat - lat) < 1e-4 && Math.abs(res.body.lon - lon) < 1e-4,
    JSON.stringify(res.body));
}
r = await asJson(me.access_token, "/maplink", { method: "POST", body: { url: "https://example.com/просто/страница" } });
ok("незнакомая ссылка не притворяется точкой", r.body.found === false);

r = await asJson(me.access_token, `/trips/${tripId}/places`, {
  method: "POST",
  body: {
    title: "Серные бани", kind: "activity", day: "2026-05-02", timeFrom: "11:00",
    costAmount: 60, costPer: "person", mapUrl: "https://yandex.ru/maps/?ll=44.8093%2C41.6892&z=17",
    lat: 41.6892, lon: 44.8093, note: "взять полотенце",
  },
});
const bath = r.body.places?.[0];
ok("место добавлено", r.status === 200 && bath?.title === "Серные бани");
ok("координаты сохранились", bath?.lat === 41.6892 && bath?.lon === 44.8093);

r = await asJson(me.access_token, `/trips/${tripId}/places`, {
  method: "POST", body: { title: "Отель у моста", kind: "stay", day: "2026-05-01", costAmount: 300 },
});
ok("второе место добавлено", r.body.places?.length === 2);

// Широты больше 90 не бывает — значит пара пришла перевёрнутой и её надо выправить.
// (Пару вроде 44.8/41.7 распознать нельзя в принципе: оба числа — законные широты.
// Поэтому перестановка сторон — единственная эвристика, которую мы себе позволяем.)
r = await asJson(me.access_token, `/trips/${tripId}/places`, {
  method: "POST", body: { title: "Перевёрнутая пара", lat: 120.5, lon: 41.7 },
});
let flipped = r.body.places.find(p => p.title === "Перевёрнутая пара");
ok("перевёрнутые координаты выправлены", flipped.lat === 41.7 && flipped.lon === 120.5, JSON.stringify(flipped));

r = await asJson(me.access_token, `/places/${flipped.id}`, { method: "PATCH", body: { lat: 200, lon: 300 } });
flipped = r.body.places.find(p => p.id === flipped.id);
ok("бессмысленные координаты не сохраняются", flipped.lat === null && flipped.lon === null, JSON.stringify(flipped));

/* ---------- 8. Чек-лист ---------- */
r = await asJson(me.access_token, `/places/${bath.id}`, { method: "PATCH", body: { done: true } });
const checked = r.body.places.find(p => p.id === bath.id);
ok("пункт отмечен", checked?.done === true && checked.doneBy === (await meId()));
r = await asJson(me.access_token, `/places/${bath.id}`, { method: "PATCH", body: { done: false } });
ok("отметка снимается", r.body.places.find(p => p.id === bath.id).done === false);

async function meId() {
  const payload = JSON.parse(Buffer.from(me.access_token.split(".")[1], "base64url"));
  return payload.sub;
}

/* ---------- 9. Порядок мест ---------- */
const ids = r.body.places.map(p => p.id);
r = await asJson(me.access_token, `/trips/${tripId}/places/reorder`, { method: "POST", body: { ids: ids.slice().reverse() } });
const order = r.body.places.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(p => p.id);
ok("порядок переставился", JSON.stringify(order) === JSON.stringify(ids.slice().reverse()));

/* ---------- 10. Приглашение по ссылке ---------- */
r = await asJson(me.access_token, "/trips/" + tripId);
const code = r.body.trip.joinCode;
r = await asJson(friend.access_token, "/invite/" + code);
ok("приглашение читается до присоединения", r.status === 200 && r.body.title === "Грузия на майские" && r.body.alreadyMember === false);
r = await asJson(friend.access_token, `/invite/${code}/join`, { method: "POST" });
ok("попутчик присоединился", r.status === 200 && r.body.tripId === tripId && r.body.joined === true);
r = await asJson(friend.access_token, "/trips/" + tripId);
ok("теперь поездка ему видна", r.status === 200 && r.body.members.length === 2);
ok("он участник, а не владелец", r.body.trip.myRole === "member");

r = await asJson(friend.access_token, `/trips/${tripId}/places`, { method: "POST", body: { title: "Хинкальная", kind: "food", costAmount: 40 } });
ok("участник может добавлять места", r.status === 200 && r.body.places.some(p => p.title === "Хинкальная"));
r = await asJson(friend.access_token, "/trips/" + tripId, { method: "DELETE" });
ok("участник не может удалить поездку", r.status === 403);

r = await asJson(me.access_token, `/trips/${tripId}/code`, { method: "DELETE" });
ok("владелец закрыл доступ по ссылке", r.status === 200 && r.body.joinCode === null);
r = await asJson(friend.access_token, "/invite/" + code);
ok("старая ссылка больше не работает", r.status === 404);

/* ---------- 11. Фотографии ---------- */
// Минимальный настоящий PNG 1×1 — важна именно сигнатура файла: сервер верит ей,
// а не заголовку Content-Type.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let up = await call(me.access_token, `/places/${bath.id}/photos`, { method: "POST", raw: true, body: PNG, headers: { "Content-Type": "image/png" } });
const photo = (await up.json()).photo;
ok("фото загружено", up.status === 200 && !!photo?.id);
ok("тип определён по сигнатуре", photo?.mime === "image/png");

const got = await call(friend.access_token, "/photos/" + photo.id);
const bytes = Buffer.from(await got.arrayBuffer());
ok("попутчик видит фото и байты те же", got.status === 200 && bytes.equals(PNG));

up = await call(me.access_token, `/places/${bath.id}/photos`, { method: "POST", raw: true, body: Buffer.from("не картинка вовсе"), headers: { "Content-Type": "image/png" } });
ok("не-картинка отбита (415)", up.status === 415);

r = await asJson(me.access_token, "/trips/" + tripId);
ok("фото попало в карточку места", r.body.places.find(p => p.id === bath.id).photos.length === 1);

const stranger = await asJson(friend.access_token, "/photos/" + photo.id, { method: "DELETE" });
ok("чужое фото участник не удаляет", stranger.status === 403);
ok("автор своё фото удаляет", (await asJson(me.access_token, "/photos/" + photo.id, { method: "DELETE" })).status === 200);
ok("файл с диска исчез", fs.readdirSync(WORK + "/trip/photos").length === 0);

/* ---------- 12. Выход и удаление ---------- */
r = await asJson(me.access_token, `/trips/${tripId}/leave`, { method: "POST" });
ok("единственный владелец не может выйти", r.status === 409);
r = await asJson(friend.access_token, `/trips/${tripId}/leave`, { method: "POST" });
ok("участник выходит свободно", r.status === 200);
ok("после выхода поездка ему не видна", (await asJson(friend.access_token, "/trips/" + tripId)).status === 404);

r = await asJson(me.access_token, "/trips/" + tripId, { method: "DELETE" });
ok("владелец удалил поездку", r.status === 200);
ok("список снова пуст", (await asJson(me.access_token, "/trips")).body.trips.length === 0);

/* ---------- итог ---------- */
for (const { p } of procs) p.kill();
await sleep(300);
if (failures) {
  console.log("\nЛоги сервисов:");
  for (const { name, log } of procs) console.log(`\n--- ${name} ---\n${log.join("")}`);
}
console.log(failures ? `\nПровалено проверок: ${failures}` : "\nВсё сошлось.");
process.exit(failures ? 1 : 0);
