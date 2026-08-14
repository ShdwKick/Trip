/**
 * Сквозная проверка «Куда поедем?»: auth (8788) + trip (8790).
 * Поднимает оба сервиса сама и имитирует ровно то, что делает браузер: вход по
 * authorization code + PKCE, работу со списком мест, приглашение второго
 * человека по ссылке и загрузку фотографии.
 *
 * Запуск (Node 24; на Node 22 добавьте --experimental-sqlite):
 *   node test/e2e.mjs
 *
 * Порты 8788 и 8790 на время прогона должны быть свободны — или задайте свои:
 *   AUTH_PORT=8793 TRIP_PORT=8795 node test/e2e.mjs
 * Ожидает, что рядом
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
const AUTH_PORT = parseInt(process.env.AUTH_PORT || "8788", 10);
const TRIP_PORT = parseInt(process.env.TRIP_PORT || "8790", 10);
const AUTH = `http://localhost:${AUTH_PORT}`;
const TRIP = `http://localhost:${TRIP_PORT}`;
const NODE_ARGS = process.version.startsWith("v22") ? ["--experimental-sqlite"] : [];

if (!fs.existsSync(path.join(AUTH_DIR, "server.js"))) {
  console.error(`Не нашёл auth-сервис в ${AUTH_DIR}. Укажите путь через AUTH_DIR.`);
  process.exit(1);
}
for (const [url, port] of [[AUTH, AUTH_PORT], [TRIP, TRIP_PORT]]) {
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
authCli("adduser", "danil", "ПарольДляТеста-2026", "danil@example.com");
authCli("adduser", "sputnik", "ПарольПопутчика-2026");   // без почты — пригодится проверить отказ без неё

/* ---------- 2. Запуск сервисов ---------- */
const procs = [];
function start(name, cwd, env) {
  const p = spawn("node", [...NODE_ARGS, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  p.stdout.on("data", d => log.push(String(d)));
  p.stderr.on("data", d => log.push(String(d)));
  procs.push({ name, p, log });
}
start("auth", AUTH_DIR, { ...authEnv, DEV: "1", ISSUER: AUTH, PORT: String(AUTH_PORT), HOST: "127.0.0.1" });
const ADMIN_KEY = "e2e-test-admin-key";
start("trip", TRIP_DIR, {
  ...process.env, DATA_DIR: WORK + "/trip", PORT: String(TRIP_PORT), HOST: "127.0.0.1",
  AUTH_ISSUER: AUTH, AUTH_CLIENT_ID: "trip",
  RESOLVE_SHORT_LINKS: "0",   // в тесте наружу не ходим
  PUBLIC_URL: TRIP,           // включает напоминания; RESEND_API_KEY нет — письмо уйдёт в консоль, не наружу
  ADMIN_INTERNAL_KEY: ADMIN_KEY,
  REMIND_INITIAL_DELAY_MS: "999999999",   // проверку сроков дёргаем сами — автотаймер не должен вмешаться
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

/* ---------- 10.5. Имя из общего кабинета ---------- */
// Имя необязательное и показывается, только если человек сам включил показ.
// Оно подписано внутрь токена, поэтому старый токен о нём не знает — сервису
// имя приезжает лишь со следующим, и это ровно то, что здесь проверяется.
const setProfile = (token, body) => fetch(`${AUTH}/api/account/profile`, {
  method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: JSON.stringify(body),
});
const refreshToken = rt => fetch(`${AUTH}/oauth/token`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ grant_type: "refresh_token", client_id: "trip", refresh_token: rt }),
}).then(x => x.json());

ok("имя сохранено в auth", (await setProfile(me.access_token, { displayName: "Данила", showDisplayName: true })).status === 200);
let fresh = await refreshToken(me.refresh_token);
ok("свежий токен выдан", !!fresh.access_token);

r = await asJson(fresh.access_token, "/trips");
ok("сервис отдаёт имя рядом с логином", r.body.me?.name === "Данила" && r.body.me?.username === "danil", JSON.stringify(r.body.me));
r = await asJson(fresh.access_token, "/trips/" + tripId);
ok("имя доехало до участника поездки", r.body.members.find(m => m.username === "danil")?.name === "Данила");

ok("показ имени выключен", (await setProfile(fresh.access_token, { displayName: "Данила", showDisplayName: false })).status === 200);
fresh = await refreshToken(fresh.refresh_token);
r = await asJson(fresh.access_token, "/trips/" + tripId);
ok("выключенный показ убирает имя обратно", r.body.members.find(m => m.username === "danil")?.name === null,
  JSON.stringify(r.body.members));
me.access_token = fresh.access_token;   // дальше работаем свежим

/* ---------- 10.7. Счета: кто платил и как делится ---------- */
const myId = JSON.parse(Buffer.from(me.access_token.split(".")[1], "base64url")).sub;
const friendId = JSON.parse(Buffer.from(friend.access_token.split(".")[1], "base64url")).sub;

// Попутчик вышел из поездки в п.12 — сейчас он ещё в ней, но ссылку мы уже
// закрыли, поэтому вернём его напрямую: для счетов нужны двое.
r = await asJson(me.access_token, `/trips/${tripId}/code`, { method: "POST" });
const code2 = r.body.joinCode;
await asJson(friend.access_token, `/invite/${code2}/join`, { method: "POST" });

r = await asJson(me.access_token, `/trips/${tripId}/places`, {
  method: "POST", body: { title: "Ужин в «Шоти»", kind: "food", costAmount: 3000, costPer: "total", paidBy: myId },
});
let bill = r.body.places.find(p => p.title === "Ужин в «Шоти»");
ok("плательщик сохранён", bill?.paidBy === myId, JSON.stringify({ paidBy: bill?.paidBy, split: bill?.split }));
ok("по умолчанию делится поровну", bill?.split === "equal" && bill.shares.length === 0);

r = await asJson(me.access_token, `/places/${bill.id}`, {
  method: "PATCH",
  body: { split: "custom", shares: [{ userId: myId, amount: 1800 }, { userId: friendId, amount: 1200 }] },
});
bill = r.body.places.find(p => p.id === bill.id);
ok("свои суммы сохранились", bill.split === "custom" && bill.shares.length === 2
  && bill.shares.find(s => s.userId === friendId).amount === 1200, JSON.stringify(bill.shares));

// Доля постороннего в своде долгов превратилась бы в долг призрака.
r = await asJson(me.access_token, `/places/${bill.id}`, {
  method: "PATCH", body: { shares: [{ userId: myId, amount: 3000 }, { userId: "00000000-0000-0000-0000-000000000000", amount: 500 }] },
});
bill = r.body.places.find(p => p.id === bill.id);
ok("доля не-участника отброшена", bill.shares.length === 1 && bill.shares[0].userId === myId, JSON.stringify(bill.shares));

r = await asJson(me.access_token, `/places/${bill.id}`, { method: "PATCH", body: { paidBy: "00000000-0000-0000-0000-000000000000" } });
bill = r.body.places.find(p => p.id === bill.id);
ok("плательщиком нельзя назначить постороннего", bill.paidBy === null);

// Возврат к «поровну» обязан убрать доли: иначе они остались бы висеть и
// молча пересилили бы новый режим при следующем чтении.
r = await asJson(me.access_token, `/places/${bill.id}`, { method: "PATCH", body: { split: "equal", shares: [], paidBy: myId } });
bill = r.body.places.find(p => p.id === bill.id);
ok("возврат к «поровну» стирает доли", bill.split === "equal" && bill.shares.length === 0);

/* ---------- 10.75. Позиции чека ---------- */
r = await asJson(me.access_token, `/trips/${tripId}/places`, {
  method: "POST", body: { title: "Чайхана", kind: "food", paidBy: myId },
});
const check = r.body.places.find(p => p.title === "Чайхана");
r = await asJson(me.access_token, `/places/${check.id}/items`, {
  method: "POST",
  body: {
    items: [
      { title: "Чайник улуна", amount: 900, users: [myId, friendId] },   // делим на двоих
      { title: "Хачапури", amount: 600, users: [myId] },                  // только моё
      { title: "Салат", amount: 400 },                                    // никто не взял
    ],
  },
});
let dish = r.body.places.find(p => p.id === check.id);
ok("позиции добавлены", dish.items.length === 3, JSON.stringify(dish.items.map(i => i.title)));
ok("цена места собралась из позиций", dish.costAmount === 1900 && dish.costPer === "total", String(dish.costAmount));
ok("режим переключился на «по позициям»", dish.split === "items");
ok("кто взял позицию — сохранилось", dish.items.find(i => i.title === "Чайник улуна").users.length === 2);
ok("неразобранная позиция без людей", dish.items.find(i => i.title === "Салат").users.length === 0);

const tea = dish.items.find(i => i.title === "Чайник улуна");
r = await asJson(friend.access_token, `/items/${tea.id}/take`, { method: "POST" });
dish = r.body.places.find(p => p.id === check.id);
ok("«моё» снимается тем же нажатием", dish.items.find(i => i.id === tea.id).users.length === 1);

r = await asJson(friend.access_token, `/items/${tea.id}`, { method: "PATCH", body: { amount: 1000, users: [myId, friendId] } });
dish = r.body.places.find(p => p.id === check.id);
ok("цена позиции правится, сумма места пересчитывается", dish.costAmount === 2000, String(dish.costAmount));

r = await asJson(me.access_token, `/items/${tea.id}`, { method: "PATCH", body: { users: ["00000000-0000-0000-0000-000000000000"] } });
dish = r.body.places.find(p => p.id === check.id);
ok("посторонний в позицию не попадает", dish.items.find(i => i.id === tea.id).users.length === 0);

/* ---------- 10.76. Позиции чека — блок гостя ---------- */
// Блок гостя — общий круг людей на все его строки: назначили одному —
// назначили всем позициям блока разом, одним запросом, а не по одной.
r = await asJson(me.access_token, `/places/${check.id}/items`, {
  method: "POST",
  body: {
    items: [
      { title: "Пряники", amount: 300, guest: "Гость 1" },
      { title: "Чай", amount: 150, guest: "Гость 1" },
      { title: "Кофе", amount: 250, guest: "Гость 2" },
    ],
  },
});
dish = r.body.places.find(p => p.id === check.id);
const g1 = dish.items.filter(i => i.guest === "Гость 1");
ok("позиции гостя добавлены с меткой", g1.length === 2 && dish.items.filter(i => i.guest === "Гость 2").length === 1, JSON.stringify(dish.items));

r = await asJson(me.access_token, `/places/${check.id}/items/guest`, { method: "PATCH", body: { guest: "Гость 1", users: [myId] } });
dish = r.body.places.find(p => p.id === check.id);
ok("ОДНИМ ЗАПРОСОМ НАЗНАЧЕНЫ ОБЕ ПОЗИЦИИ ГОСТЯ", dish.items.filter(i => i.guest === "Гость 1").every(i => i.users.length === 1 && i.users[0] === myId), JSON.stringify(dish.items));
ok("другой гость не затронут", dish.items.find(i => i.guest === "Гость 2").users.length === 0);

r = await asJson(me.access_token, `/places/${check.id}/items/guest`, { method: "PATCH", body: { guest: "Гость 1", users: [] } });
dish = r.body.places.find(p => p.id === check.id);
ok("список людей можно снова опустошить — снимается со всего блока", dish.items.filter(i => i.guest === "Гость 1").every(i => i.users.length === 0));

ok("несуществующий гость отбит", (await asJson(me.access_token, `/places/${check.id}/items/guest`, { method: "PATCH", body: { guest: "Нет такого", users: [myId] } })).status === 404);
ok("пустое имя гостя отбито", (await asJson(me.access_token, `/places/${check.id}/items/guest`, { method: "PATCH", body: { guest: "", users: [myId] } })).status === 400);

for (const it of dish.items) await asJson(me.access_token, "/items/" + it.id, { method: "DELETE" });
r = await asJson(me.access_token, "/trips/" + tripId);
dish = r.body.places.find(p => p.id === check.id);
ok("без позиций режим возвращается к «поровну»", dish.split === "equal" && dish.items.length === 0);
await asJson(me.access_token, "/places/" + check.id, { method: "DELETE" });

/* ---------- 10.8. Переводы ---------- */
r = await asJson(friend.access_token, `/trips/${tripId}/settlements`, { method: "POST", body: { toUser: myId, amount: 1500 } });
ok("перевод отмечен", r.status === 200 && r.body.settlements.length === 1, JSON.stringify(r.body.settlements));
const settlement = r.body.settlements[0];
ok("перевод записан от имени отправителя", settlement.fromUser === friendId && settlement.toUser === myId && settlement.amount === 1500);
ok("подтверждения ещё нет", settlement.confirmedAt === null);

r = await asJson(friend.access_token, `/settlements/${settlement.id}/confirm`, { method: "POST" });
ok("отправитель не может подтвердить получение", r.status === 403);
r = await asJson(me.access_token, `/settlements/${settlement.id}/confirm`, { method: "POST" });
ok("получатель подтверждает", r.status === 200 && r.body.settlements[0].confirmedAt > 0);

r = await asJson(me.access_token, `/trips/${tripId}/settlements`, { method: "POST", body: { toUser: myId, amount: 100 } });
ok("перевод самому себе отбит", r.status === 400);
r = await asJson(me.access_token, `/trips/${tripId}/settlements`, { method: "POST", body: { toUser: friendId, amount: -5 } });
ok("отрицательная сумма отбита", r.status === 400);

r = await asJson(me.access_token, `/settlements/${settlement.id}`, { method: "DELETE" });
ok("сторона перевода может убрать запись", r.status === 200 && r.body.settlements.length === 0);

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

/* ---------- 12. Что взять с собой ---------- */
// Главное здесь — что галочки личные: в списке мест отметка общая, а рюкзак
// каждый собирает свой, и «Маша сложила паспорт» ничего не говорит о вашем.
r = await asJson(me.access_token, `/trips/${tripId}/packing`, { method: "POST", body: { title: "Переходник", note: "тип C" } });
ok("вещь добавлена", r.status === 200 && r.body.packing?.length === 1, r.body.error || "");
const thing = r.body.packing[0];
ok("новая вещь никем не сложена", thing.packed === false);
ok("вещь без названия отбита", (await asJson(me.access_token, `/trips/${tripId}/packing`, { method: "POST", body: { title: "  " } })).status === 400);

r = await asJson(me.access_token, `/trips/${tripId}/packing/${thing.id}/packed`, { method: "POST", body: { packed: true } });
ok("отметил, что сложил", r.body.packing[0].packed === true);
r = await asJson(friend.access_token, "/trips/" + tripId);
ok("список вещей общий", r.body.packing?.length === 1 && r.body.packing[0].title === "Переходник");
ok("ЧУЖАЯ ГАЛОЧКА НЕ ВИДНА: у попутчика вещь не сложена", r.body.packing[0].packed === false);

r = await asJson(friend.access_token, `/trips/${tripId}/packing/${thing.id}/packed`, { method: "POST", body: { packed: true } });
ok("попутчик отметил себе", r.body.packing[0].packed === true);
r = await asJson(me.access_token, `/trips/${tripId}/packing/${thing.id}/packed`, { method: "POST", body: { packed: false } });
ok("снял свою отметку", r.body.packing[0].packed === false);
ok("а у попутчика она осталась", (await asJson(friend.access_token, "/trips/" + tripId)).body.packing[0].packed === true);

r = await asJson(friend.access_token, `/trips/${tripId}/packing/${thing.id}`, { method: "PATCH", body: { title: "Переходник тип C" } });
ok("название правит любой участник", r.body.packing[0].title === "Переходник тип C");
r = await asJson(friend.access_token, `/trips/${tripId}/packing/${thing.id}`, { method: "DELETE" });
ok("вещь убрана", r.status === 200 && r.body.packing.length === 0);
ok("чужой вещи в другой поездке нет", (await asJson(me.access_token, `/trips/${tripId}/packing/${thing.id}/packed`, { method: "POST", body: {} })).status === 404);

/* ---------- 13. Напоминания на почту ---------- */
// danil@example.com указан при заведении аккаунта, у sputnik почты нет —
// этим и пользуемся, чтобы проверить отказ без неё.
const cfg2 = await (await fetch(TRIP + "/api/config")).json();
ok("конфиг сообщает о включённых напоминаниях", cfg2.reminders === true && cfg2.remindOffsets?.length === 5, JSON.stringify(cfg2));

r = await asJson(me.access_token, `/trips/${tripId}/packing`, { method: "POST", body: { title: "Аптечка" } });
const pill = r.body.packing.find(i => i.title === "Аптечка");
ok("новая вещь без напоминания", pill.remind === null);

r = await asJson(friend.access_token, `/trips/${tripId}/packing/${pill.id}/remind`, { method: "POST", body: { offset: "1d" } });
ok("БЕЗ ПОЧТЫ НАПОМИНАНИЕ НЕ СТАВИТСЯ", r.status === 400 && r.body.error === "no_email", JSON.stringify(r.body));

r = await asJson(me.access_token, `/trips/${tripId}/packing/${pill.id}/remind`, { method: "POST", body: { offset: "не число" } });
ok("неизвестный срок отбит", r.status === 400 && r.body.error === "bad offset");

r = await asJson(me.access_token, `/trips/${tripId}/packing/${pill.id}/remind`, { method: "POST", body: { offset: "3d" } });
ok("напоминание поставлено", r.status === 200 && r.body.packing.find(i => i.id === pill.id)?.remind?.offset === "3d", JSON.stringify(r.body));

r = await asJson(friend.access_token, "/trips/" + tripId);
ok("ЧУЖОЕ НАПОМИНАНИЕ НЕ ВИДНО", r.body.packing.find(i => i.id === pill.id)?.remind === null);

r = await asJson(me.access_token, `/trips/${tripId}/packing/${pill.id}/remind`, { method: "POST", body: { offset: "1h" } });
const afterChange = r.body.packing.find(i => i.id === pill.id)?.remind;
ok("срок можно поменять, метка «отправлено» сбрасывается", afterChange?.offset === "1h" && afterChange?.sent === false);

// Поездка «Грузия на майские» начинается 2026-05-01 — раньше сегодняшней даты
// (сейчас 2026-08-14), поэтому любой срок для неё уже наступил. Заведём вторую
// поездку далеко в будущем — на ней ничего наступить не должно.
r = await asJson(me.access_token, "/trips", { method: "POST", body: { title: "Далёкая поездка", startsOn: "2030-01-01" } });
const futureTrip = r.body.trip.id;
r = await asJson(me.access_token, `/trips/${futureTrip}/packing`, { method: "POST", body: { title: "Компас" } });
const futureItem = r.body.packing[0];
await asJson(me.access_token, `/trips/${futureTrip}/packing/${futureItem.id}/remind`, { method: "POST", body: { offset: "1h" } });

r = await fetch(TRIP + "/internal/reminders/check", { method: "POST", headers: { "x-admin-key": ADMIN_KEY } });
const checkResult = await r.json();
ok("ручной прогон сработал", r.status === 200 && checkResult.ok === true, JSON.stringify(checkResult));
ok("отправлено ровно одно письмо — только просроченное", checkResult.sent === 1, JSON.stringify(checkResult));

r = await asJson(me.access_token, "/trips/" + tripId);
ok("просроченное отмечено отправленным", r.body.packing.find(i => i.id === pill.id)?.remind?.sent === true);
r = await asJson(me.access_token, "/trips/" + futureTrip);
ok("будущее — ещё не отправлено", r.body.packing.find(i => i.id === futureItem.id)?.remind?.sent === false);

r = await fetch(TRIP + "/internal/reminders/check", { method: "POST", headers: { "x-admin-key": ADMIN_KEY } });
ok("повторный прогон не шлёт то же письмо снова", (await r.json()).sent === 0);
ok("без ключа прогон запретят", (await fetch(TRIP + "/internal/reminders/check", { method: "POST" })).status === 403);

r = await asJson(me.access_token, `/trips/${tripId}/packing/${pill.id}/remind`, { method: "POST", body: { enabled: false } });
ok("напоминание выключено", r.body.packing.find(i => i.id === pill.id)?.remind === null);
ok("тестовую поездку из будущего убрали", (await asJson(me.access_token, "/trips/" + futureTrip, { method: "DELETE" })).status === 200);

r = await asJson(me.access_token, "/trips", { method: "POST", body: { title: "Без даты" } });
const noDateTrip = r.body.trip.id;
r = await asJson(me.access_token, `/trips/${noDateTrip}/packing`, { method: "POST", body: { title: "Гид" } });
const noDateItem = r.body.packing[0];
r = await asJson(me.access_token, `/trips/${noDateTrip}/packing/${noDateItem.id}/remind`, { method: "POST", body: { offset: "1d" } });
ok("БЕЗ ДАТЫ НАЧАЛА НАПОМИНАНИЕ НЕ СТАВИТСЯ", r.status === 400 && r.body.error === "no_date", JSON.stringify(r.body));
ok("тестовую поездку без даты убрали", (await asJson(me.access_token, "/trips/" + noDateTrip, { method: "DELETE" })).status === 200);

/* ---------- 14. Выход и удаление ---------- */
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
