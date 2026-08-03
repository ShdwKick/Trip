"use strict";
/**
 * Куда поедем? — фронтенд.
 *
 * Одностраничное приложение без сборки: браузер получает этот файл как есть.
 * Данные живут на сервере (см. server.js), состояние тут держится в `state` и
 * перерисовывается целиком — поездка это десятки мест, а не тысячи, и точечные
 * обновления DOM тут стоили бы дороже, чем экономят.
 *
 * Маршрутизация — по хэшу: #/ (список), #/t/<id> (поездка), #/join/<код>.
 * Хэш выбран не случайно: redirect_uri в auth сверяется побайтово, а хэш в
 * него не входит — значит адрес возврата остаётся одним и тем же, какую бы
 * страницу человек ни открыл.
 */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let auth = null;
let state = {
  me: null,          // { id, username, name }
  trips: [],         // список поездок
  trip: null,        // открытая поездка целиком
  filter: "all",     // all | todo | done
  maxPhotoBytes: 4 * 1024 * 1024,
};

// ───────────────────────── мелочи оформления ─────────────────────────
const KINDS = [
  { id: "stay",      label: "Жильё",      icon: '<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M9 21v-6h6v6"/>' },
  { id: "food",      label: "Еда",        icon: '<path d="M6 3v8a3 3 0 0 0 6 0V3"/><path d="M9 11v10"/><path d="M18 3c-1.5 2-2 4-2 6s.5 3 2 3v9"/>' },
  { id: "sight",     label: "Посмотреть", icon: '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>' },
  { id: "transport", label: "Дорога",     icon: '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a1 1 0 0 0-1 1.6L8 11l-2 3H3l2 4 4 2 3-2v-3l3-4 3.2 4.2a1 1 0 0 0 1.6-1z"/>' },
  { id: "spot",      label: "Разное",     icon: '<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>' },
];
// Незнакомый тип (например убранное «Занятие» у мест, заведённых раньше)
// показываем как «Разное» — это последний элемент списка и общий случай.
const kindOf = id => KINDS.find(k => k.id === id) || KINDS[KINDS.length - 1];
const svg = (paths, cls = "icon sm") => `<svg class="${cls}" viewBox="0 0 24 24">${paths}</svg>`;

const STATUS_LABEL = { planning: "Планируем", active: "В пути", done: "Съездили" };

function money(v, currency) {
  if (v == null || !Number.isFinite(v)) return "";
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency", currency: currency || "RUB",
      minimumFractionDigits: 0, maximumFractionDigits: v % 1 ? 2 : 0,
    }).format(v);
  } catch {
    // Валюта могла приехать из базы кодом, которого браузер не знает.
    return `${v.toLocaleString("ru-RU")} ${currency || ""}`.trim();
  }
}
const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dayFmtShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const weekdayFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
const parseDay = d => (d ? new Date(d + "T12:00:00") : null);   // полдень: так не съезжает день при любом часовом поясе

function dateRange(from, to) {
  if (!from && !to) return "даты не выбраны";
  if (from && to) {
    const a = parseDay(from), b = parseDay(to);
    const days = Math.round((b - a) / 86400000) + 1;
    return `${dayFmtShort.format(a)} — ${dayFmtShort.format(b)}${days > 0 ? ` · ${days} ${plural(days, "день", "дня", "дней")}` : ""}`;
  }
  return from ? `с ${dayFmtShort.format(parseDay(from))}` : `по ${dayFmtShort.format(parseDay(to))}`;
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
const initials = name => (name || "?").trim().slice(0, 2);

/**
 * Как подписывать человека. `name` — необязательное имя из общего кабинета
 * BurningHouse: оно есть, только если человек сам включил его показ, и тогда
 * это его решение, действующее сразу во всех сервисах. Иначе остаётся логин.
 */
const who = u => (u && (u.name || u.username)) || "участник";

let snackTimer = null;
function snack(text) {
  const s = $("snack");
  s.textContent = text;
  s.classList.add("show");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => s.classList.remove("show"), 3200);
}
function setSync(mode) {
  const chip = $("syncChip");
  chip.hidden = !state.me;
  chip.className = "sync" + (mode === "saving" ? " saving" : mode === "offline" ? " offline" : "");
  $("syncText").textContent = mode === "saving" ? "Сохраняем…" : mode === "offline" ? "Нет связи" : "Сохранено";
}

// ───────────────────────── тема ─────────────────────────
const SUN = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("trip.theme", theme);
  $("themeBtn").innerHTML = theme === "dark" ? SUN : MOON;
}
$("themeBtn").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
applyTheme(localStorage.getItem("trip.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

addEventListener("scroll", () => $("appbar").classList.toggle("scrolled", scrollY > 4), { passive: true });

// ───────────────────────── запросы ─────────────────────────
class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || "ошибка запроса"); this.status = status; this.body = body; }
}

async function api(path, { method = "GET", body, raw, headers } = {}) {
  setSync(method === "GET" ? "ok" : "saving");
  let res;
  try {
    res = await auth.fetch("/api" + path, {
      method,
      headers: raw ? headers : (body ? { "Content-Type": "application/json", ...headers } : headers),
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Единственный случай, когда пользователя надо вернуть на вход: access
    // протух И обновить его не удалось. Своей формы входа у сервиса нет —
    // сразу уводим на общую.
    if (e && e.name === "AuthRequiredError") { auth.clearTokens(); state.me = null; goLogin(); throw e; }
    setSync("offline");
    throw e;
  }
  if (res.status === 204) { setSync("ok"); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { setSync("ok"); throw new ApiError(res.status, data); }
  setSync("ok");
  return data;
}

/** Обёртка для действий: сама показывает причину отказа, не роняя приложение. */
async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) snack(okText);
    return r;
  } catch (e) {
    if (e instanceof ApiError) snack(e.message);
    else if (e && e.name !== "AuthRequiredError") snack("Не получилось — проверьте связь");
    return null;
  }
}

// ───────────────────────── старт и маршрутизация ─────────────────────────
const ROUTE_KEY = "trip.route";   // куда вернуть человека после входа: хэш переживает редирект только так

async function init() {
  const cfg = await (await fetch("/api/config")).json();
  state.maxPhotoBytes = cfg.maxPhotoBytes || state.maxPhotoBytes;
  auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    redirectUri: location.origin + location.pathname,   // ровно то, что зарегистрировано в auth
    storagePrefix: "trip",
  });

  // Обязательно ДО первого запроса к своему API: обменивает ?code=… на токены.
  const returned = await auth.handleRedirect();
  if (returned) {
    const saved = sessionStorage.getItem(ROUTE_KEY);
    sessionStorage.removeItem(ROUTE_KEY);
    if (saved && saved !== location.hash) { location.hash = saved; }
  }

  // Своей страницы входа у сервиса нет и не нужно: аккаунт общий, форма живёт
  // на auth-домене. Неавторизованного уводим туда молча — на проде «увидеть
  // сервис без входа» всё равно нельзя, а лишний экран-заглушка только добавил
  // бы клик к тому, что и так произойдёт.
  if (!auth.isAuthenticated()) return goLogin();

  // Кто я — знаем сразу из токена, не дожидаясь списка поездок. Иначе при
  // заходе прямо по ссылке на поездку интерфейс не понимает, где «вы»:
  // пропадают и пометки, и кнопка «Перевести» у своего долга.
  state.me = auth.getUser() || state.me;

  $("accountBtn").hidden = false;
  $("logoutBtn").hidden = false;
  $("accountBtn").onclick = () => window.open(auth.accountUrl(), "_blank", "noopener");
  $("logoutBtn").onclick = () => auth.logout();

  await route();
}

/** Экран «нужен вход» — только на случай сбоя: увести на auth не удалось.
    В обычной жизни он не показывается ни на кадр. */
function showAuthScreen(title, note) {
  showOnly("authView");
  $("accountBtn").hidden = true;
  $("logoutBtn").hidden = true;
  $("syncChip").hidden = true;
  $("authTitle").textContent = title;
  $("authNote").textContent = note;
}

/** Уход на страницу входа. Если на экране есть карточка — она уезжает здесь и
    собирается там: фон общий, и переход читается как одна страница, а не две
    (см. .bh-leaving в brand.css). В обычном случае уходим сразу. */
function goLogin() {
  if (!auth) return showAuthScreen("Сервер недоступен", "Не удалось узнать адрес входа. Обновите страницу — возможно, сервис ещё поднимается.");
  // Хэш не входит в redirect_uri (тот сверяется побайтово), поэтому открытая
  // страница переживает вход только так. Особенно важно для ссылки-приглашения.
  sessionStorage.setItem(ROUTE_KEY, location.hash || "#/");
  const card = document.querySelector("#authView:not([hidden]) .panel");
  if (!card || matchMedia("(prefers-reduced-motion: reduce)").matches) return auth.login();
  card.classList.add("bh-leaving");
  setTimeout(() => auth.login(), 200);   // длительность обязана совпадать с .bh-leaving
}
$("loginBtn").onclick = goLogin;

function showOnly(id) {
  for (const v of ["authView", "tripsView", "tripView", "joinView"]) $(v).hidden = v !== id;
}

async function route() {
  if (!auth || !auth.isAuthenticated()) return goLogin();
  const hash = location.hash || "#/";
  const join = hash.match(/^#\/join\/([A-Za-z0-9]+)/);
  const trip = hash.match(/^#\/t\/([0-9a-f-]{36})/i);

  if (join) return showJoin(join[1].toUpperCase());
  if (trip) return openTrip(trip[1]);
  return showTrips();
}
addEventListener("hashchange", () => { route().catch(console.error); });

// ───────────────────────── список поездок ─────────────────────────
async function showTrips() {
  showOnly("tripsView");
  state.trip = null;
  document.title = "Куда поедем?";   // ушли из поездки — вернули вопрос без ответа
  const data = await act(() => api("/trips"));
  if (!data) return;
  state.me = data.me;
  state.trips = data.trips;
  setSync("ok");
  renderTrips();
}

function renderTrips() {
  const grid = $("tripGrid");
  grid.textContent = "";
  const trips = state.trips;
  $("tripsEmpty").hidden = trips.length > 0;
  $("tripsSub").textContent = trips.length
    ? `${trips.length} ${plural(trips.length, "поездка", "поездки", "поездок")} · вы вошли как ${who(state.me)}`
    : `Вы вошли как ${who(state.me)}`;

  trips.forEach((t, i) => {
    const card = el("button", "trip-card");
    card.style.animationDelay = Math.min(i * 40, 240) + "ms";
    const pct = t.places ? Math.round((t.placesDone / t.places) * 100) : 0;
    card.innerHTML = `
      <div class="tc-top">
        <span class="tc-title">${esc(t.title)}</span>
        <span class="chip status" data-s="${t.status}">${STATUS_LABEL[t.status] || ""}</span>
      </div>
      ${t.destination ? `<div class="tc-dest">${svg('<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', "icon xs")}${esc(t.destination)}</div>` : ""}
      <div class="tc-dates">${esc(dateRange(t.startsOn, t.endsOn))}</div>
      <div class="progress${pct === 100 ? " full" : ""}"><i style="width:${pct}%"></i></div>
      <div class="tc-foot">
        <span class="bit">${svg('<polyline points="20 6 9 17 4 12"/>', "icon xs")}${t.placesDone}/${t.places}</span>
        <span class="bit">${svg('<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/>', "icon xs")}${t.members}</span>
        ${t.photos ? `<span class="bit">${svg('<path d="M3 7h3l2-2h8l2 2h3v13H3z"/><circle cx="12" cy="13" r="4"/>', "icon xs")}${t.photos}</span>` : ""}
        ${t.myRole === "owner" ? '<span class="spacer"></span><span class="bit">моя</span>' : ""}
      </div>`;
    card.onclick = () => { location.hash = "#/t/" + t.id; };
    grid.append(card);
  });
}

$("newTripBtn").onclick = () => openTripDialog();

// ───────────────────────── одна поездка ─────────────────────────
async function openTrip(id) {
  showOnly("tripView");
  const data = await act(() => api("/trips/" + id));
  if (!data) { location.hash = "#/"; return; }
  state.trip = data;
  renderTrip();
}

function tripCosts() {
  const { trip, members, places } = state.trip;
  const heads = Math.max(members.length, 1);
  let total = 0;
  for (const p of places) {
    if (!Number.isFinite(p.costAmount)) continue;
    total += p.costPer === "person" ? p.costAmount * heads : p.costAmount;
  }
  return { total, perHead: total / heads, currency: trip.currency, heads };
}

/**
 * Расшифровка сметы. Одна цифра в шапке всегда вызывает вопрос «откуда
 * столько», а идти за ответом в список из двадцати мест — долго.
 */
function openCostDialog() {
  const { trip, places } = state.trip;
  const { total, perHead, currency, heads } = tripCosts();

  const priced = places
    .filter(p => Number.isFinite(p.costAmount))
    .sort((a, b) => (a.day || "9999").localeCompare(b.day || "9999")
      || (a.timeFrom || "99:99").localeCompare(b.timeFrom || "99:99")
      || a.sortOrder - b.sortOrder);

  const box = $("costList");
  box.textContent = "";
  for (const p of priced) {
    const row = el("div", "cost-row");
    // Раскладку «цена × людей» показываем только когда людей больше одного:
    // иначе это то же самое число, написанное дважды.
    const perPerson = p.costPer === "person" && heads > 1;
    row.innerHTML =
      `<span class="nm">${esc(p.title)}</span>` +
      (p.day ? `<span class="day">${esc(dayFmtShort.format(parseDay(p.day)))}</span>` : "") +
      `<span class="sum">${esc(money(p.costPer === "person" ? p.costAmount * heads : p.costAmount, p.costCurrency || currency))}` +
      (perPerson ? ` <span class="per">${esc(money(p.costAmount, p.costCurrency || currency))} × ${heads}</span>` : "") +
      `</span>`;
    box.append(row);
  }
  if (!priced.length) {
    box.append(Object.assign(el("div", "hint"), { textContent: "Пока ни у одного места не указана цена — смете складываться не из чего." }));
  }

  // «На человека» — среднее по смете, а «ваша доля» учитывает, что где-то вы не
  // участвуете или платите иначе. Когда числа расходятся, важнее второе.
  const mine = priced.reduce((sum, p) => sum + myShare(p, heads), 0);
  $("costTotal").innerHTML = priced.length
    ? `<span class="k">Итого</span><span class="v">${esc(money(total, currency))}</span>` +
      (heads > 1 ? `<span class="head">ваша доля ${esc(money(round2(mine), currency))}</span>` : "")
    : "";

  const noPrice = places.length - priced.length;
  $("costHint").textContent = noPrice
    ? `Ещё ${noPrice} ${plural(noPrice, "место", "места", "мест")} без цены — в смету они не попали.`
    : "Считаются все места списка, включая уже отмеченные.";

  openScrim("costScrim");
}

function renderTrip() {
  const { trip, members, places } = state.trip;
  // Вкладка читается как вопрос и ответ на него: «Куда поедем? — Суздаль».
  document.title = "Куда поедем? — " + trip.title;

  $("thTitle").textContent = trip.title;
  const st = $("thStatus");
  st.textContent = STATUS_LABEL[trip.status] || "";
  st.dataset.s = trip.status;

  const meta = $("thMeta");
  meta.innerHTML = [
    trip.destination ? `<span class="bit">${svg('<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', "icon xs")}${esc(trip.destination)}</span>` : "",
    `<span class="bit">${svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>', "icon xs")}${esc(dateRange(trip.startsOn, trip.endsOn))}</span>`,
  ].filter(Boolean).join("");

  $("thDesc").hidden = !trip.description;
  $("thDesc").textContent = trip.description || "";

  const done = places.filter(p => p.done).length;
  const { total, perHead, currency, heads } = tripCosts();
  // Обе денежные плитки — кнопки: смета складывается из десятка мест, и
  // единственная цифра без расшифровки вызывает вопрос «откуда столько».
  $("thStats").innerHTML = `
    <div class="stat"><div class="k">Отмечено</div><div class="v">${done} <small>из ${places.length}</small></div></div>
    <button class="stat tap" data-cost><div class="k">Смета</div><div class="v">${esc(money(total, currency) || "—")}</div></button>
    <button class="stat tap" data-cost><div class="k">На человека</div><div class="v">${esc(money(perHead, currency) || "—")} <small>× ${heads}</small></div></button>`;
  $("thStats").querySelectorAll("[data-cost]").forEach(b => { b.onclick = openCostDialog; });

  const people = $("thPeople");
  people.textContent = "";
  const iAmOwner = trip.myRole === "owner";
  for (const m of members) {
    const chip = el("span", "person" + (m.role === "owner" ? " owner" : ""));
    chip.innerHTML = `<span class="ava">${esc(initials(who(m)))}</span><span>${esc(who(m))}</span>`;
    if (iAmOwner && m.userId !== state.me?.id) {
      if (m.role !== "owner") {
        const crown = el("button", "icon-btn xs");
        crown.title = "Передать владение";
        crown.innerHTML = svg('<path d="M3 18h18"/><path d="M4 8l4 4 4-7 4 7 4-4v7H4z"/>', "icon xs");
        crown.onclick = () => confirmDialog("Передать владение?", `${who(m)} сможет менять и удалять поездку. Вы останетесь владельцем тоже — владельцев может быть несколько.`, "Передать", async () => {
          await act(() => api(`/trips/${trip.id}/members/${m.userId}`, { method: "PATCH", body: { role: "owner" } }), "Готово");
          openTrip(trip.id);
        });
        chip.append(crown);
      }
      const kick = el("button", "icon-btn xs kick");
      kick.title = "Убрать из поездки";
      kick.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
      kick.onclick = () => confirmDialog("Убрать участника?", `${who(m)} потеряет доступ к поездке. Добавленные им места и фото останутся.`, "Убрать", async () => {
        await act(() => api(`/trips/${trip.id}/members/${m.userId}`, { method: "DELETE" }), "Убрали");
        openTrip(trip.id);
      });
      chip.append(kick);
    }
    people.append(chip);
  }

  renderDebts();
  renderPlaces();
}

// ───────────────────────── кто кому должен ─────────────────────────
/**
 * Баланс каждого: сколько заплатил минус сколько должен был. Из балансов
 * собираются переводы — жадно, от самого большого долга к самому большому
 * кредиту. Так число переводов минимально: компании важно «Маша отдаёт Данилу
 * 1 400», а не десять переводов по каждому чеку.
 */
function tripDebts() {
  const { members, places, settlements } = state.trip;
  const heads = Math.max(members.length, 1);
  const balance = new Map(members.map(m => [m.userId, 0]));
  const add = (id, v) => { if (balance.has(id)) balance.set(id, balance.get(id) + v); };

  for (const p of places) {
    const total = placeTotal(p, heads);
    if (!total || !p.paidBy || !balance.has(p.paidBy)) continue;   // без плательщика делить нечего
    add(p.paidBy, total);
    if (p.split === "items" && p.items?.length) {
      // По позициям: каждый должен за то, что взял; неразобранное делится на всех.
      for (const m of members) add(m.userId, -itemsShareOf(p, m.userId, members));
    } else if (p.split === "custom" && p.shares.length) {
      let assigned = 0;
      for (const s of p.shares) { add(s.userId, -s.amount); assigned += s.amount; }
      // Нераспределённый остаток несёт тот, кто платил, — так сумма всегда сходится.
      add(p.paidBy, -round2(total - assigned));
    } else {
      for (const m of members) add(m.userId, -total / heads);
    }
  }
  // Уже сделанные переводы гасят долг сразу, не дожидаясь подтверждения:
  // иначе человек, который честно перевёл, снова видел бы себя должником.
  for (const s of settlements) { add(s.fromUser, s.amount); add(s.toUser, -s.amount); }

  const debtors = [], creditors = [];
  for (const [id, v] of balance) {
    if (v < -0.005) debtors.push({ id, sum: -v });
    else if (v > 0.005) creditors.push({ id, sum: v });
  }
  debtors.sort((a, b) => b.sum - a.sum);
  creditors.sort((a, b) => b.sum - a.sum);

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].sum, creditors[j].sum);
    transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: round2(amount) });
    debtors[i].sum -= amount;
    creditors[j].sum -= amount;
    if (debtors[i].sum < 0.005) i++;
    if (creditors[j].sum < 0.005) j++;
  }
  return { transfers, balance };
}

function renderDebts() {
  const { trip, members, places, settlements } = state.trip;
  const panel = $("debtsPanel");
  const withPayer = places.filter(p => p.paidBy && placeTotal(p, Math.max(members.length, 1)) > 0);

  // Панель без единого счёта с плательщиком — пустая строка в интерфейсе.
  if (!withPayer.length && !settlements.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const { transfers } = tripDebts();
  const byId = id => members.find(m => m.userId === id);
  const list = $("debtList");
  list.textContent = "";
  $("debtCount").textContent = transfers.length ? String(transfers.length) : "";

  for (const t of transfers) {
    const row = el("div", "debt-row");
    const mine = t.from === state.me?.id;
    row.innerHTML =
      `<span class="who">${esc(who(byId(t.from)))}${mine ? " (вы)" : ""}</span>` +
      `<span class="arrow">${svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>', "icon xs")}</span>` +
      `<span class="who">${esc(who(byId(t.to)))}${t.to === state.me?.id ? " (вы)" : ""}</span>` +
      `<span class="sum">${esc(money(t.amount, trip.currency))}</span>`;
    if (mine) {
      const pay = el("button", "btn tonal");
      pay.textContent = "Перевести";
      pay.onclick = () => openPayDialog(byId(t.to), t.amount);
      row.append(pay);
    }
    list.append(row);
  }
  if (!transfers.length) {
    list.append(Object.assign(el("div", "hint"), { textContent: "Все в расчёте — переводить никому ничего не нужно." }));
  }

  const settled = $("settleList");
  settled.textContent = "";
  for (const s of settlements) {
    const row = el("div", "settle-row" + (s.confirmedAt ? " done" : ""));
    const iSent = s.fromUser === state.me?.id;
    const iGot = s.toUser === state.me?.id;
    row.innerHTML =
      `<span>${esc(who(byId(s.fromUser)))} → ${esc(who(byId(s.toUser)))} · ${esc(money(s.amount, trip.currency))}</span>` +
      `<span class="state">${s.confirmedAt ? "получено" : "ждёт подтверждения"}</span>`;
    if (!s.confirmedAt && iGot) {
      const ok = el("button", "btn text");
      ok.textContent = "Получил";
      ok.onclick = async () => {
        const data = await act(() => api(`/settlements/${s.id}/confirm`, { method: "POST" }), "Отмечено");
        if (data) { state.trip = data; renderTrip(); }
      };
      row.append(ok);
    }
    if (iSent || iGot) {
      const del = el("button", "icon-btn xs danger");
      del.title = "Убрать запись о переводе";
      del.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
      del.onclick = () => confirmDialog("Убрать перевод?", "Запись исчезнет, и долг снова станет виден. Деньги это не двигает — только отметку.", "Убрать", async () => {
        const data = await act(() => api("/settlements/" + s.id, { method: "DELETE" }), "Убрано");
        if (data) { state.trip = data; renderTrip(); }
      });
      row.append(del);
    }
    settled.append(row);
  }

  const noPayer = places.filter(p => !p.paidBy && p.costAmount != null).length;
  $("debtHint").textContent = noPayer
    ? `У ${noPayer} ${plural(noPayer, "места", "мест", "мест")} с ценой не указано, кто платил — они в расчёт не вошли.`
    : "Статус перевода в банке сервису недоступен: «Я перевёл» и «Получил» отмечаете вы сами.";
}

// ───────────────────────── перевод ─────────────────────────
let payTo = null;

function openPayDialog(member, amount) {
  payTo = member;
  $("payTitle").textContent = `Перевод: ${who(member)}`;
  $("payAmount").value = String(amount);

  const box = $("payWhere");
  box.textContent = "";
  if (member?.phone) {
    const phone = member.phone;
    const row = el("div", "pay-phone");
    row.innerHTML = `<span class="num">${esc(formatPhone(phone))}</span>`;
    const copy = el("button", "btn tonal");
    copy.textContent = "Скопировать";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(phone); snack("Номер скопирован"); }
      catch { snack("Скопируйте номер вручную"); }
    };
    row.append(copy);
    box.append(row);

    // Ссылки в банк по номеру. Это не СБП-ссылки (их выдаёт только банк-эквайер
    // по договору), а собственные страницы выбора банка у Сбера и Т-Банка: они
    // открывают перевод по СБП с уже подставленным номером.
    const banks = el("div", "pay-banks");
    for (const [label, url] of [
      ["Сбербанк", `https://www.sberbank.ru/ru/choise_bank?requisiteNumber=${encodeURIComponent(phone.replace(/^\+/, ""))}&bankCode=100000000111`],
      ["Т-Банк", `https://t.tb.ru/c2c-qr-choose-bank?requisiteNumber=${encodeURIComponent(phone)}&bankCode=100000000004`],
    ]) {
      const a = el("a", "btn outlined", label);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      banks.append(a);
    }
    box.append(banks);
    box.append(Object.assign(el("p", "hint"), {
      // Сумму в эти ссылки не подставить: параметр нигде не описан, а угаданный
      // молча проигнорируется — человек решит, что сумма подставлена, и отправит
      // не то. Поэтому сумма остаётся на экране, её копируют.
      textContent: "Кнопки открывают перевод по номеру через СБП. Сумму придётся ввести в банке руками — подставить её ссылкой нельзя.",
    }));
  } else {
    box.append(Object.assign(el("div", "pay-empty"), {
      innerHTML: `<b>${esc(who(member))}</b> не поделился номером телефона.<br>` +
        `Номер указывается один раз в аккаунте BurningHouse — там же есть отдельная галочка «показывать сервисам». ` +
        `Попросите включить её, либо спросите реквизиты напрямую и отметьте перевод здесь.`,
    }));
  }
  openScrim("payScrim");
}

/** +7 900 123-45-67 — так номер читается глазами, а копируется всё равно сырым. */
function formatPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length !== 11) return p;
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

$("payDoneBtn").onclick = async () => {
  const amount = parseAmount($("payAmount").value);
  if (!(amount > 0)) return snack("Сумма должна быть больше нуля");
  const data = await act(() => api(`/trips/${state.trip.trip.id}/settlements`, {
    method: "POST", body: { toUser: payTo.userId, amount },
  }), "Отметили перевод");
  if (!data) return;
  closeScrim("payScrim");
  state.trip = data;
  renderTrip();
};

// ───────────────────────── чек-лист мест ─────────────────────────
/** Группировка по дням. Без даты — отдельной группой в конце: это «когда-нибудь
    в этой поездке», а не ошибка ввода. */
function groupPlaces(places) {
  const byDay = new Map();
  for (const p of places) {
    const key = p.day || "";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }
  const keys = [...byDay.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return keys.map(day => ({
    day,
    places: byDay.get(day).sort((a, b) =>
      (a.timeFrom || "99:99").localeCompare(b.timeFrom || "99:99") || a.sortOrder - b.sortOrder),
  }));
}

function renderPlaces() {
  const { trip, places } = state.trip;
  const box = $("placeList");
  box.textContent = "";

  const visible = places.filter(p => state.filter === "all" || (state.filter === "done" ? p.done : !p.done));
  $("placesEmpty").hidden = places.length > 0;
  if (!visible.length && places.length) {
    box.append(Object.assign(el("div", "empty"), {
      innerHTML: `<h3>${state.filter === "done" ? "Ничего не отмечено" : "Всё отмечено"}</h3><p>${state.filter === "done" ? "Отмечайте пункты галочкой — они попадут сюда." : "Список пройден целиком."}</p>`,
    }));
    return;
  }

  const start = parseDay(trip.startsOn);
  for (const group of groupPlaces(visible)) {
    const wrap = el("div", "day-group");
    const head = el("div", "day-head");
    if (group.day) {
      const d = parseDay(group.day);
      const nth = start ? Math.round((d - start) / 86400000) + 1 : null;
      head.innerHTML =
        (nth && nth > 0 ? `<span class="num">${nth}</span>` : "") +
        `<span>${esc(dayFmt.format(d))}</span><span class="rest">${esc(weekdayFmt.format(d))}</span>`;
    } else {
      head.innerHTML = '<span>Без даты</span><span class="rest">когда-нибудь за поездку</span>';
    }
    head.append(el("span", "spacer"));
    const withGeo = group.places.filter(p => p.lat != null);
    if (withGeo.length > 1) {
      const rb = el("button", "btn text");
      rb.innerHTML = svg('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6"/>') + "Маршрут дня";
      rb.onclick = () => openRouteDialog(group.day);
      head.append(rb);
    }
    // Добавить сразу в этот день: планируют по дням, и заново выбирать дату в
    // диалоге — лишний шаг ровно там, где он чаще всего не нужен.
    const ab = el("button", "btn text");
    ab.innerHTML = svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>') + "Место";
    ab.onclick = () => openPlaceDialog(null, group.day);
    head.append(ab);
    wrap.append(head);
    for (const p of group.places) wrap.append(placeCard(p, group.places));
    box.append(wrap);
  }
}

function placeCard(p, siblings) {
  const { trip } = state.trip;
  const card = el("div", "place" + (p.done ? " done" : ""));
  card.dataset.id = p.id;

  // Галочка
  const check = el("button", "check" + (p.done ? " on" : ""));
  check.setAttribute("aria-label", p.done ? "Снять отметку" : "Отметить");
  check.innerHTML = svg('<polyline points="20 6 9 17 4 12"/>', "icon sm");
  check.onclick = async e => {
    e.stopPropagation();
    card.classList.toggle("done");           // отзывчиво: ответ сервера догонит
    check.classList.toggle("on");
    const data = await act(() => api(`/places/${p.id}`, { method: "PATCH", body: { done: !p.done } }));
    if (data) { state.trip = data; renderTrip(); }
  };

  // Тело
  const body = el("div", "p-body");
  const k = kindOf(p.kind);
  const line = [];
  if (p.timeFrom) line.push(`<span class="bit">${svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', "icon xs")}${esc(p.timeFrom)}${p.timeTo ? "–" + esc(p.timeTo) : ""}</span>`);
  if (Number.isFinite(p.costAmount)) {
    line.push(`<span class="bit cost">${esc(money(p.costAmount, p.costCurrency || trip.currency))}${p.costPer === "person" ? " / чел." : ""}</span>`);
  }
  if (p.address) line.push(`<span class="bit">${svg('<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', "icon xs")}${esc(p.address)}</span>`);
  if (p.paidBy) {
    const payer = state.trip.members.find(m => m.userId === p.paidBy);
    if (payer) {
      line.push(`<span class="bit">${svg('<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/>', "icon xs")}` +
        `платил${payer.userId === state.me?.id ? "и вы" : ": " + esc(who(payer))}` +
        `${p.split === "custom" ? ", по-разному" : ""}</span>`);
    }
  }
  if (p.done && p.doneBy) {
    // «отметил/отметила» здесь не написать, не угадывая род, — поэтому безличное.
    const by = state.trip.members.find(m => m.userId === p.doneBy);
    if (by) line.push(`<span class="bit">отмечено: ${by.userId === state.me?.id ? "вы" : esc(who(by))}</span>`);
  }

  body.innerHTML = `
    <div class="p-head">
      <span class="p-kind" title="${esc(k.label)}">${svg(k.icon)}</span>
      <div style="min-width:0;flex:1">
        <div class="p-title">${esc(p.title)}</div>
        <div class="p-line">${line.join("")}</div>
      </div>
    </div>
    ${p.note ? `<div class="p-note">${esc(p.note)}</div>` : ""}`;

  // Ссылки и маршрут
  const links = el("div", "p-links");
  if (p.lat != null) {
    const a = el("a");
    a.href = pointUrl(p);
    a.target = "_blank"; a.rel = "noopener";
    a.innerHTML = svg('<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', "icon xs") + "На карте";
    links.append(a);

    const r = el("button", "route");
    r.innerHTML = svg('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6"/>', "icon xs") + "Маршрут";
    r.onclick = e => { e.stopPropagation(); openRouteDialog(p.day); };
    links.append(r);
  } else if (p.mapUrl) {
    const a = el("a");
    a.href = p.mapUrl; a.target = "_blank"; a.rel = "noopener";
    a.innerHTML = svg('<path d="M21 10c0 6-9 12-9 12S3 16 3 10a9 9 0 0 1 18 0z"/>', "icon xs") + "Ссылка с карты";
    links.append(a);
  }
  if (p.linkUrl) {
    const a = el("a");
    a.href = p.linkUrl; a.target = "_blank"; a.rel = "noopener";
    a.innerHTML = svg('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>', "icon xs") + "Бронь и билеты";
    links.append(a);
  }
  if (links.children.length) body.append(links);

  if (p.photos.length) body.append(photoStrip(p));

  // Правый край: перетаскивание и правка
  const side = el("div", "p-side");
  if (matchMedia("(pointer: coarse)").matches) {
    // На тач-экранах HTML5 drag&drop не работает вовсе — там стрелки.
    for (const [dir, icon, title] of [[-1, '<polyline points="18 15 12 9 6 15"/>', "Выше"], [1, '<polyline points="6 9 12 15 18 9"/>', "Ниже"]]) {
      const b = el("button", "icon-btn xs");
      b.title = title; b.innerHTML = svg(icon, "icon sm");
      b.onclick = e => { e.stopPropagation(); movePlace(p, siblings, dir); };
      side.append(b);
    }
  } else {
    const handle = el("button", "icon-btn xs drag");
    handle.title = "Перетащить";
    handle.innerHTML = svg('<circle cx="9" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/>', "icon sm");
    handle.draggable = true;
    handle.addEventListener("dragstart", e => {
      dragId = p.id;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", p.id);
      e.dataTransfer.setDragImage(card, 20, 20);
    });
    handle.addEventListener("dragend", () => { dragId = null; card.classList.remove("dragging"); clearDropMarks(); });
    side.append(handle);
  }
  const edit = el("button", "icon-btn xs");
  edit.title = "Изменить";
  edit.innerHTML = svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>', "icon sm");
  edit.onclick = e => { e.stopPropagation(); openPlaceDialog(p); };
  side.append(edit);

  card.append(check, body, side);
  card.addEventListener("dragover", onDragOver);
  card.addEventListener("drop", onDrop);
  card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
  return card;
}

// ───────────────────────── порядок мест ─────────────────────────
let dragId = null;

const clearDropMarks = () => document.querySelectorAll(".drop-before,.drop-after").forEach(n => n.classList.remove("drop-before", "drop-after"));

function onDragOver(e) {
  if (!dragId || this.dataset.id === dragId) return;
  e.preventDefault();
  const box = this.getBoundingClientRect();
  const after = e.clientY > box.top + box.height / 2;
  clearDropMarks();
  this.classList.add(after ? "drop-after" : "drop-before");
}

async function onDrop(e) {
  if (!dragId || this.dataset.id === dragId) return;
  e.preventDefault();
  const targetId = this.dataset.id;
  const after = this.classList.contains("drop-after");
  clearDropMarks();

  const places = state.trip.places;
  const moved = places.find(p => p.id === dragId);
  const target = places.find(p => p.id === targetId);
  if (!moved || !target) return;

  // Перенос в другой день — это и есть «переставить на другой день»: иначе
  // карточка визуально уехала бы в чужую группу и вернулась после перерисовки.
  const dayChanged = (moved.day || "") !== (target.day || "");

  const order = places.filter(p => p.id !== moved.id);
  const at = order.findIndex(p => p.id === targetId);
  order.splice(after ? at + 1 : at, 0, moved);

  dragId = null;
  if (dayChanged) await act(() => api(`/places/${moved.id}`, { method: "PATCH", body: { day: target.day } }));
  const data = await act(() => api(`/trips/${state.trip.trip.id}/places/reorder`, { method: "POST", body: { ids: order.map(p => p.id) } }));
  if (data) { state.trip = data; renderTrip(); }
}

/** Стрелки на тач-экранах: меняем местами с соседом внутри дня. */
async function movePlace(place, siblings, dir) {
  const i = siblings.findIndex(p => p.id === place.id);
  const j = i + dir;
  if (j < 0 || j >= siblings.length) return;
  const order = state.trip.places.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(p => p.id);
  const a = order.indexOf(siblings[i].id), b = order.indexOf(siblings[j].id);
  [order[a], order[b]] = [order[b], order[a]];
  const data = await act(() => api(`/trips/${state.trip.trip.id}/places/reorder`, { method: "POST", body: { ids: order } }));
  if (data) { state.trip = data; renderTrip(); }
}

// ───────────────────────── фильтр ─────────────────────────
$("placeFilter").addEventListener("click", e => {
  const b = e.target.closest("button[data-filter]");
  if (!b) return;
  state.filter = b.dataset.filter;
  $("placeFilter").querySelectorAll("button").forEach(x => x.classList.toggle("sel", x === b));
  renderPlaces();
});

// ───────────────────────── диалоги: общая механика ─────────────────────────
function openScrim(id) {
  $(id).classList.add("open");
  document.body.classList.add("scroll-lock");
}
function closeScrim(id) {
  $(id).classList.remove("open");
  if (!document.querySelector(".scrim.open")) document.body.classList.remove("scroll-lock");
}
document.addEventListener("click", e => {
  const scrim = e.target.classList?.contains("scrim") ? e.target : null;
  if (scrim) return closeScrim(scrim.id);
  const close = e.target.closest("[data-close]");
  if (close) closeScrim(close.closest(".scrim").id);
});
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const open = [...document.querySelectorAll(".scrim.open")].pop();
  if (open) closeScrim(open.id);
});

function confirmDialog(title, text, okLabel, onOk) {
  $("cfTitle").textContent = title;
  $("cfText").textContent = text;
  $("cfOk").textContent = okLabel;
  $("cfOk").onclick = async () => { closeScrim("confirmScrim"); await onOk(); };
  openScrim("confirmScrim");
}

// ───────────────────────── диалог поездки ─────────────────────────
let editingTrip = null;

function openTripDialog(trip) {
  editingTrip = trip || null;
  $("tripDlgTitle").textContent = trip ? "Поездка" : "Новая поездка";
  $("tdTitle").value = trip?.title || "";
  $("tdDest").value = trip?.destination || "";
  $("tdFrom").value = trip?.startsOn || "";
  $("tdTo").value = trip?.endsOn || "";
  $("tdStatus").value = trip?.status || "planning";
  $("tdDesc").value = trip?.description || "";
  $("tripDeleteBtn").hidden = !trip || trip.myRole !== "owner";
  $("tripLeaveBtn").hidden = !trip;
  openScrim("tripScrim");
  setTimeout(() => $("tdTitle").focus(), 60);
}

$("tripSaveBtn").onclick = async () => {
  const body = {
    title: $("tdTitle").value.trim() || "Новая поездка",
    destination: $("tdDest").value.trim(),
    startsOn: $("tdFrom").value || null,
    endsOn: $("tdTo").value || null,
    // currency не шлём: поле убрано из формы, у поездки остаётся рубль по
    // умолчанию (а у уже созданных — то, что там записано).
    status: $("tdStatus").value,
    description: $("tdDesc").value.trim(),
  };
  if (body.startsOn && body.endsOn && body.endsOn < body.startsOn) return snack("Дата возвращения раньше даты отъезда");

  if (editingTrip) {
    const data = await act(() => api("/trips/" + editingTrip.id, { method: "PATCH", body }), "Сохранено");
    if (!data) return;
    closeScrim("tripScrim");
    state.trip = data;
    renderTrip();
  } else {
    const data = await act(() => api("/trips", { method: "POST", body }), "Поездка создана");
    if (!data) return;
    closeScrim("tripScrim");
    location.hash = "#/t/" + data.trip.id;
  }
};

$("tripDeleteBtn").onclick = () => {
  const t = editingTrip;
  confirmDialog("Удалить поездку?", `«${t.title}» исчезнет у всех участников вместе с местами и фотографиями. Отменить это будет нельзя.`, "Удалить", async () => {
    closeScrim("tripScrim");
    await act(() => api("/trips/" + t.id, { method: "DELETE" }), "Поездка удалена");
    location.hash = "#/";
  });
};

$("tripLeaveBtn").onclick = () => {
  const t = editingTrip;
  confirmDialog("Выйти из поездки?", "Вы перестанете её видеть. Добавленные вами места и фото останутся у остальных.", "Выйти", async () => {
    closeScrim("tripScrim");
    const ok = await act(() => api(`/trips/${t.id}/leave`, { method: "POST" }), "Вы вышли из поездки");
    if (ok) location.hash = "#/";
  });
};

$("tripEditBtn").onclick = () => openTripDialog(state.trip.trip);

// ───────────────────────── диалог места ─────────────────────────
let editingPlace = null;
let pendingPhotos = [];   // выбранные для нового места — уходят на сервер после его создания
let pdKind = "spot";
let pdGeoPoint = null;    // { lat, lon } — то, что определили из ссылки
let pdPaidBy = "";        // кто платил по счёту
let pdSplitMode = "equal";// equal | some | custom
let pdShares = new Map(); // userId → сумма, для some и custom

function openPlaceDialog(place, presetDay) {
  editingPlace = place || null;
  pendingPhotos = [];
  pdKind = kindOf(place?.kind).id;   // у старых мест тип мог быть убран из списка
  pdGeoPoint = place && place.lat != null ? { lat: place.lat, lon: place.lon } : null;

  $("placeDlgTitle").textContent = place ? "Место" : "Новое место";
  $("pdTitle").value = place?.title || "";
  $("pdDay").value = place?.day ?? (presetDay !== undefined ? presetDay : defaultDay());
  $("pdFrom").value = place?.timeFrom || "";
  $("pdTo").value = place?.timeTo || "";
  $("pdCost").value = place?.costAmount != null ? String(place.costAmount) : "";
  $("pdCostPer").value = place?.costPer || "total";
  $("pdMap").value = place?.mapUrl || "";
  $("pdAddress").value = place?.address || "";
  $("pdLink").value = place?.linkUrl || "";
  $("pdNote").value = place?.note || "";
  $("placeDeleteBtn").hidden = !place;

  // Счёт. Плательщик по умолчанию — тот, кто заводит место: чаще всего платит
  // он, а исправить одним щелчком дешевле, чем выбирать каждый раз.
  pdPaidBy = place?.paidBy || (place ? "" : state.me?.id || "");
  pdSplitMode = ["custom", "items"].includes(place?.split) ? place.split : "equal";
  pdShares = new Map((place?.shares || []).map(s => [s.userId, s.amount]));

  renderKinds();
  renderGeoHint();
  renderThumbs();
  renderBill();
  openScrim("placeScrim");
  setTimeout(() => $("pdTitle").focus(), 60);
}

// ───────────────────────── счёт: кто платил и как делится ─────────────────────────
const round2 = v => Math.round(v * 100) / 100;
const parseAmount = v => {
  const n = parseFloat(String(v ?? "").replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
};
/** Сколько всего стоит место: цена «с человека» умножается на состав. */
const placeTotal = (p, heads) => (p.costAmount == null ? 0 : (p.costPer === "person" ? p.costAmount * heads : p.costAmount));

/** Сколько по этому счёту приходится лично на меня. */
function myShare(p, heads) {
  const total = placeTotal(p, heads);
  if (!total) return 0;
  if (p.split === "items" && p.items?.length) return itemsShareOf(p, state.me?.id, state.trip.members);
  if (p.split === "custom" && p.shares.length) {
    const own = p.shares.find(s => s.userId === state.me?.id);
    let assigned = 0;
    for (const s of p.shares) assigned += s.amount;
    // Нераспределённый остаток лежит на плательщике — и в моей доле тоже.
    const rest = p.paidBy === state.me?.id ? round2(total - assigned) : 0;
    return (own ? own.amount : 0) + Math.max(0, rest);
  }
  return total / heads;
}

function renderBill() {
  const members = state.trip?.members || [];
  const total = billTotal();
  // Блок счёта нужен и при нулевой цене, если делим по позициям: цена как раз
  // и появится, когда их заведут.
  const show = total > 0 || pdSplitMode === "items" || (editingPlace?.items || []).length > 0;
  $("pdBill").hidden = !show;
  if (!show) return;

  const sel = $("pdPaidBy");
  sel.textContent = "";
  const none = el("option", null, "— не указано —");
  none.value = "";
  sel.append(none);
  for (const m of members) {
    const o = el("option", null, who(m) + (m.userId === state.me?.id ? " (вы)" : ""));
    o.value = m.userId;
    sel.append(o);
  }
  sel.value = members.some(m => m.userId === pdPaidBy) ? pdPaidBy : "";
  sel.onchange = () => { pdPaidBy = sel.value; renderBill(); };

  $("pdSplit").querySelectorAll("button").forEach(b => b.classList.toggle("sel", b.dataset.split === pdSplitMode));

  const box = $("pdShares");
  box.textContent = "";
  const foot = $("pdSharesFoot");
  $("pdItemsBlock").hidden = pdSplitMode !== "items";

  if (pdSplitMode === "items") {
    box.hidden = true;
    foot.hidden = true;
    renderItems();
    $("pdBillHint").textContent = editingPlace
      ? "Цена места считается по позициям. Чаевые и обслуживание заводите такой же строкой."
      : "";
    return;
  }

  if (pdSplitMode === "equal") {
    box.hidden = true;
    foot.hidden = true;
    $("pdBillHint").textContent = members.length > 1
      ? `Поровну между всеми: по ${money(round2(total / members.length), billCurrency())} с человека. Новый попутчик попадёт в этот счёт автоматически.`
      : "Пока вы в поездке один — счёт целиком ваш.";
    return;
  }

  box.hidden = false;
  foot.hidden = false;
  const picked = pdSplitMode === "some";
  for (const m of members) {
    const row = el("div", "share-row");
    const on = pdShares.has(m.userId);
    if (picked) {
      const check = el("button", "check sm" + (on ? " on" : ""));
      check.type = "button";
      check.innerHTML = svg('<polyline points="20 6 9 17 4 12"/>', "icon xs");
      check.onclick = () => {
        if (on) pdShares.delete(m.userId); else pdShares.set(m.userId, 0);
        spreadEqually();
        renderBill();
      };
      row.append(check);
    }
    const nm = el("span", "nm", who(m) + (m.userId === state.me?.id ? " (вы)" : ""));
    row.append(nm);

    if (picked) {
      row.append(el("span", "sum", on ? money(pdShares.get(m.userId), billCurrency()) : "—"));
    } else {
      const input = el("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.value = on ? String(pdShares.get(m.userId)) : "";
      input.placeholder = "0";
      input.oninput = () => {
        const v = parseAmount(input.value);
        if (input.value.trim() === "") pdShares.delete(m.userId); else pdShares.set(m.userId, round2(v));
        updateSharesFoot();
      };
      row.append(input);
    }
    box.append(row);
  }
  updateSharesFoot();
}

// ───────────────────────── позиции чека ─────────────────────────
// Сам разбор — в assets/receipt.js: он вынесен отдельно, чтобы проверять его
// тестами на настоящих формах строк, а не глазами в браузере (test/receipt.mjs).

let parsedItems = [];

$("pdReceiptBtn").onclick = () => {
  $("rcText").value = "";
  $("rcList").textContent = "";
  $("rcStatus").textContent = "";
  $("rcProgress").hidden = true;
  parsedItems = [];
  $("rcAddBtn").disabled = true;
  // Распознавание тянет ~6,6 МБ движка и модели, поэтому кнопку прячем там,
  // где оно всё равно не заработает, а не показываем и падаем на нажатии.
  $("rcPhotoBtn").hidden = !ocrSupported();
  openScrim("receiptScrim");
};

// ── распознавание фотографии ──
$("rcPhotoBtn").onclick = () => $("rcPhotoInput").click();
$("rcPhotoInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const bar = $("rcProgress");
  const fill = bar.firstElementChild;
  bar.hidden = false;
  fill.style.width = "2%";
  $("rcPhotoBtn").disabled = true;
  $("rcStatus").textContent = "Готовим снимок…";

  try {
    const text = await ocrReceipt(file, p => {
      fill.style.width = Math.round(p * 100) + "%";
      if (p > 0.12) $("rcStatus").textContent = "Читаем чек… " + Math.round(p * 100) + "%";
    });
    $("rcText").value = text.trim();
    // Сразу разбираем: человек фотографировал не ради текста, а ради позиций.
    $("rcParseBtn").click();
    if (!parsedItems.length) {
      $("rcStatus").textContent = "Прочитать не получилось. Поправьте текст выше или впишите позиции руками — снимок при хорошем свете и без наклона читается заметно лучше.";
    }
  } catch (err) {
    console.error(err);
    $("rcStatus").textContent = err.message || "Не удалось распознать чек";
  } finally {
    bar.hidden = true;
    $("rcPhotoBtn").disabled = false;
  }
});

$("rcParseBtn").onclick = () => {
  const { items, skipped } = parseReceipt($("rcText").value);
  parsedItems = items;
  $("rcAddBtn").disabled = !items.length;
  $("rcStatus").textContent = items.length
    ? `Нашлось позиций: ${items.length}${skipped ? `, пропущено строк: ${skipped}` : ""}. Проверьте и поправьте.`
    : "Ни одной строки с ценой не нашлось. Формат: название и цена в конце строки.";
  renderParsed();
};

function renderParsed() {
  const box = $("rcList");
  box.textContent = "";
  parsedItems.forEach((it, i) => {
    const row = el("div", "rc-row");
    const title = el("input");
    title.type = "text";
    title.value = it.title;
    title.oninput = () => { it.title = title.value; };
    const amount = el("input", "amt");
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.value = String(it.amount);
    amount.oninput = () => { it.amount = round2(parseAmount(amount.value)); };
    const del = el("button", "icon-btn xs");
    del.type = "button";
    del.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
    del.onclick = () => { parsedItems.splice(i, 1); renderParsed(); $("rcAddBtn").disabled = !parsedItems.length; };
    row.append(title, amount, del);
    box.append(row);
  });
}

$("rcAddBtn").onclick = async () => {
  if (!editingPlace) return snack("Сначала сохраните место");
  const data = await act(() => api(`/places/${editingPlace.id}/items`, { method: "POST", body: { items: parsedItems } }),
    `Добавлено позиций: ${parsedItems.length}`);
  if (!data) return;
  closeScrim("receiptScrim");
  applyTripData(data);
};

$("pdAddItemBtn").onclick = async () => {
  if (!editingPlace) return snack("Сначала сохраните место");
  const data = await act(() => api(`/places/${editingPlace.id}/items`, {
    method: "POST", body: { items: [{ title: "Позиция", amount: 0 }] },
  }));
  if (data) applyTripData(data);
};

/** Обновить состояние из ответа сервера, не теряя открытый диалог места. */
function applyTripData(data) {
  state.trip = data;
  if (editingPlace) {
    editingPlace = data.places.find(p => p.id === editingPlace.id) || editingPlace;
    // Цену считает сервер по позициям — возвращаем её в поле, иначе при
    // сохранении места пустое поле затёрло бы сумму чека.
    if (editingPlace.split === "items") {
      $("pdCost").value = editingPlace.costAmount != null ? String(editingPlace.costAmount) : "";
      $("pdCostPer").value = "total";
    }
  }
  renderTrip();
  renderBill();
}

function renderItems() {
  const box = $("pdItems");
  box.textContent = "";
  const items = editingPlace?.items || [];
  const members = state.trip.members;

  for (const it of items) {
    const row = el("div", "item-row");
    const mine = it.users.includes(state.me?.id);

    const check = el("button", "check sm" + (mine ? " on" : ""));
    check.type = "button";
    check.title = mine ? "Это не моё" : "Это моё";
    check.innerHTML = svg('<polyline points="20 6 9 17 4 12"/>', "icon xs");
    check.onclick = async () => {
      const data = await act(() => api(`/items/${it.id}/take`, { method: "POST" }));
      if (data) applyTripData(data);
    };

    const title = el("input", "nm");
    title.type = "text";
    title.value = it.title;
    title.onchange = async () => {
      const data = await act(() => api("/items/" + it.id, { method: "PATCH", body: { title: title.value } }));
      if (data) applyTripData(data);
    };

    const amount = el("input", "amt");
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.value = String(it.amount);
    amount.onchange = async () => {
      const data = await act(() => api("/items/" + it.id, { method: "PATCH", body: { amount: parseAmount(amount.value) } }));
      if (data) applyTripData(data);
    };

    // Кто делит позицию. Чайник на троих — обычное дело, поэтому список людей
    // правится прямо здесь, а не только «моё/не моё».
    const share = el("button", "who-btn");
    share.type = "button";
    share.textContent = it.users.length
      ? (it.users.length === 1 ? who(members.find(m => m.userId === it.users[0])) : `делят ${it.users.length}`)
      : "на всех";
    share.title = it.users.length
      ? it.users.map(u => who(members.find(m => m.userId === u))).join(", ")
      : "Позицию никто не разобрал — делится на всех";
    share.onclick = () => openItemPeople(it);

    const del = el("button", "icon-btn xs");
    del.type = "button";
    del.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
    del.onclick = async () => {
      const data = await act(() => api("/items/" + it.id, { method: "DELETE" }));
      if (data) applyTripData(data);
    };

    row.append(check, title, amount, share, del);
    box.append(row);
  }

  if (!items.length) {
    box.append(Object.assign(el("div", "hint"), {
      textContent: editingPlace
        ? "Позиций пока нет. Вставьте чек текстом или добавьте вручную."
        : "Сначала сохраните место — позиции добавляются к уже существующему счёту.",
    }));
  }

  const mineSum = round2(itemsShareOf(editingPlace, state.me?.id, members));
  $("pdItemsMine").textContent = items.length ? `Ваша сумма: ${money(mineSum, billCurrency())}` : "";
  $("pdItemsCopy").hidden = !items.length;
  $("pdItemsCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(String(mineSum)); snack("Сумма скопирована"); }
    catch { snack("Скопируйте сумму вручную"); }
  };
}

/** Простой выбор, кто делит позицию: список участников с галочками. */
function openItemPeople(item) {
  const members = state.trip.members;
  const chosen = new Set(item.users);
  const box = $("cfText");
  $("cfTitle").textContent = item.title;
  box.textContent = "";
  const list = el("div", "shares");
  for (const m of members) {
    const row = el("div", "share-row");
    const check = el("button", "check sm" + (chosen.has(m.userId) ? " on" : ""));
    check.type = "button";
    check.innerHTML = svg('<polyline points="20 6 9 17 4 12"/>', "icon xs");
    check.onclick = () => {
      if (chosen.has(m.userId)) chosen.delete(m.userId); else chosen.add(m.userId);
      check.classList.toggle("on");
    };
    row.append(check, el("span", "nm", who(m) + (m.userId === state.me?.id ? " (вы)" : "")));
    list.append(row);
  }
  box.append(Object.assign(el("p", "hint"), { textContent: "Кто это заказывал. Никого не отметить — позиция разделится на всех." }), list);
  $("cfOk").textContent = "Сохранить";
  $("cfOk").onclick = async () => {
    closeScrim("confirmScrim");
    const data = await act(() => api("/items/" + item.id, { method: "PATCH", body: { users: [...chosen] } }));
    if (data) applyTripData(data);
  };
  openScrim("confirmScrim");
}

/** Сколько по позициям приходится на человека. */
function itemsShareOf(place, userId, members) {
  const items = place?.items || [];
  if (!items.length || !userId) return 0;
  const heads = Math.max(members.length, 1);
  let sum = 0;
  for (const it of items) {
    if (it.users.length) { if (it.users.includes(userId)) sum += it.amount / it.users.length; }
    else sum += it.amount / heads;   // никем не разобранное — на всех
  }
  return sum;
}

function billTotal() {
  const heads = Math.max((state.trip?.members || []).length, 1);
  const amount = parseAmount($("pdCost").value);
  return $("pdCostPer").value === "person" ? round2(amount * heads) : round2(amount);
}
const billCurrency = () => state.trip?.trip?.currency || "RUB";

/** Остаток распределяем поровну между выбранными — самый частый жест. */
function spreadEqually() {
  const ids = pdSplitMode === "some"
    ? [...pdShares.keys()]
    : (state.trip?.members || []).map(m => m.userId);
  if (!ids.length) return;
  const total = billTotal();
  const each = Math.floor((total / ids.length) * 100) / 100;
  ids.forEach(id => pdShares.set(id, each));
  // Копейки от деления достаются плательщику: кому-то их отдать всё равно надо,
  // а тот, кто платил, и так держит счёт целиком.
  const rest = round2(total - each * ids.length);
  if (rest) {
    const to = ids.includes(pdPaidBy) ? pdPaidBy : ids[0];
    pdShares.set(to, round2(pdShares.get(to) + rest));
  }
}

function updateSharesFoot() {
  const total = billTotal();
  let assigned = 0;
  for (const v of pdShares.values()) assigned += v;
  assigned = round2(assigned);
  const left = round2(total - assigned);
  const cur = billCurrency();
  $("pdSharesLeft").textContent = left === 0
    ? `Разложено полностью: ${money(total, cur)}`
    : left > 0
      ? `Осталось разложить ${money(left, cur)} из ${money(total, cur)}`
      : `Разложено на ${money(-left, cur)} больше, чем счёт`;
  $("pdSharesLeft").className = left === 0 ? "ok" : left < 0 ? "over" : "";
  $("pdBillHint").textContent = left > 0
    ? "Нераспределённый остаток ляжет на того, кто платил."
    : "";
}

$("pdSplit").addEventListener("click", e => {
  const b = e.target.closest("button[data-split]");
  if (!b) return;
  const was = pdSplitMode;
  pdSplitMode = b.dataset.split;
  if (pdSplitMode !== "equal" && pdSplitMode !== "items") {
    // Со своими суммами «цена с человека» теряет смысл: сумма счёта берётся
    // как есть, а кто сколько должен — уже в долях ниже.
    if ($("pdCostPer").value === "person") {
      $("pdCost").value = String(billTotal());
      $("pdCostPer").value = "total";
    }
    if (!pdShares.size) for (const m of state.trip.members) pdShares.set(m.userId, 0);
    // «На выбранных» — это именно поровну между отмеченными, поэтому при входе
    // в режим суммы пересчитываются. «Свои суммы» ничего не трогают: там как
    // раз и хотят сохранить введённое руками.
    if (pdSplitMode === "some" && was !== "some") spreadEqually();
  }
  renderBill();
});
$("pdSpreadBtn").onclick = () => { spreadEqually(); renderBill(); };
$("pdCost").addEventListener("input", renderBill);
$("pdCostPer").addEventListener("change", renderBill);

/** Новое место по умолчанию попадает в первый день поездки — чаще всего
    планируют подряд, и переставить дату дешевле, чем вводить её каждый раз. */
function defaultDay() {
  const t = state.trip?.trip;
  if (!t?.startsOn) return "";
  const today = new Date().toISOString().slice(0, 10);
  if (t.endsOn && today >= t.startsOn && today <= t.endsOn) return today;  // уже в пути
  return t.startsOn;
}

function renderKinds() {
  const box = $("pdKinds");
  box.textContent = "";
  for (const k of KINDS) {
    const b = el("button", "kind" + (k.id === pdKind ? " sel" : ""));
    b.type = "button";
    b.innerHTML = svg(k.icon, "icon xs") + esc(k.label);
    b.onclick = () => { pdKind = k.id; renderKinds(); };
    box.append(b);
  }
}

function renderGeoHint() {
  const box = $("pdGeo");
  if (pdGeoPoint) {
    box.innerHTML = `Точка найдена: <b>${pdGeoPoint.lat}, ${pdGeoPoint.lon}</b> — маршрут построится. ` +
      `<a href="#" id="pdGeoClear">убрать</a>`;
    $("pdGeoClear").onclick = e => { e.preventDefault(); pdGeoPoint = null; renderGeoHint(); };
  } else {
    box.textContent = "Вставьте ссылку из Яндекс.Карт, Google Maps или 2ГИС — координаты возьмутся сами, и появится кнопка маршрута.";
  }
}

/** Разбор ссылки. Сначала пробуем прямо в браузере (мгновенно и без запроса),
    и только для коротких ссылок-редиректов идём на сервер. */
async function detectGeo(showResult) {
  const raw = $("pdMap").value.trim();
  if (!raw) { pdGeoPoint = null; return renderGeoHint(); }
  const local = parseGeoClient(raw);
  if (local) { pdGeoPoint = local; return renderGeoHint(); }

  $("pdGeo").textContent = "Разворачиваем ссылку…";
  const res = await act(() => api("/maplink", { method: "POST", body: { url: raw } }));
  if (res?.found) { pdGeoPoint = { lat: res.lat, lon: res.lon }; renderGeoHint(); }
  else {
    pdGeoPoint = null;
    $("pdGeo").textContent = "Координаты в ссылке не нашлись — место сохранится, но без маршрута. Можно вписать «55.75, 37.61» вручную.";
    if (showResult) snack("Не удалось определить точку");
  }
}
$("pdMapBtn").onclick = () => detectGeo(true);
$("pdMap").addEventListener("change", () => detectGeo(false));

$("placeSaveBtn").onclick = async () => {
  const body = {
    title: $("pdTitle").value.trim() || "Новое место",
    kind: pdKind,
    day: $("pdDay").value || null,
    timeFrom: $("pdFrom").value || null,
    timeTo: $("pdTo").value || null,
    costAmount: $("pdCost").value.trim() ? Number($("pdCost").value.replace(",", ".").replace(/\s/g, "")) : null,
    costPer: $("pdCostPer").value,
    mapUrl: $("pdMap").value.trim() || null,
    lat: pdGeoPoint?.lat ?? null,
    lon: pdGeoPoint?.lon ?? null,
    address: $("pdAddress").value.trim() || null,
    linkUrl: $("pdLink").value.trim() || null,
    note: $("pdNote").value.trim() || null,
    paidBy: pdPaidBy || null,
    // «На выбранных» — это те же свои суммы, просто заполненные поровну:
    // отдельного режима в базе нет, иначе пришлось бы хранить ещё и состав.
    split: pdSplitMode === "equal" ? "equal" : "custom",
    shares: pdSplitMode === "equal" ? [] : [...pdShares].map(([userId, amount]) => ({ userId, amount })),
  };
  if (body.costAmount != null && !Number.isFinite(body.costAmount)) return snack("Цена — это число");

  const tripId = state.trip.trip.id;
  let data;
  if (editingPlace) data = await act(() => api(`/places/${editingPlace.id}`, { method: "PATCH", body }));
  else data = await act(() => api(`/trips/${tripId}/places`, { method: "POST", body }));
  if (!data) return;

  // Фото нового места ждали, пока у него появится id.
  if (pendingPhotos.length) {
    const created = editingPlace
      ? editingPlace
      : data.places.slice().sort((a, b) => b.sortOrder - a.sortOrder)[0];
    for (const blob of pendingPhotos) await uploadPhoto(created.id, blob);
    pendingPhotos = [];
    data = await act(() => api("/trips/" + tripId));
  }

  closeScrim("placeScrim");
  state.trip = data;
  renderTrip();
};

$("placeDeleteBtn").onclick = () => {
  const p = editingPlace;
  confirmDialog("Удалить место?", `«${p.title}» исчезнет из списка вместе со своими фотографиями.`, "Удалить", async () => {
    closeScrim("placeScrim");
    const data = await act(() => api(`/places/${p.id}`, { method: "DELETE" }), "Удалено");
    if (data) { state.trip = data; renderTrip(); }
  });
};

$("newPlaceBtn").onclick = () => openPlaceDialog();

// ───────────────────────── фотографии ─────────────────────────
/**
 * Уменьшаем снимок прямо в браузере. Телефонная фотография — это 3–6 МБ, и
 * гонять их целиком по мобильному интернету ради картинки 74×56 в списке
 * бессмысленно; после сжатия уходит около 200 КБ.
 */
async function shrink(file, maxSide = 1600, quality = 0.82) {
  if (!file.type.startsWith("image/")) throw new Error("не картинка");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;                       // формат, который канвас не понял, — отправим как есть
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 600 * 1024) { bitmap.close?.(); return file; }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
  return blob && blob.size < file.size ? blob : file;
}

async function uploadPhoto(placeId, blob) {
  return act(() => api(`/places/${placeId}/photos`, {
    method: "POST", raw: true, body: blob, headers: { "Content-Type": blob.type || "image/jpeg" },
  }));
}

$("pdPhotoBtn").onclick = () => $("pdPhotoInput").click();
$("pdPhotoInput").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    let blob;
    try { blob = await shrink(file); } catch { snack(`«${file.name}» — не изображение`); continue; }
    if (blob.size > state.maxPhotoBytes) { snack(`«${file.name}» слишком тяжёлое даже после сжатия`); continue; }
    if (editingPlace) {
      const mark = addUploadingThumb(blob);
      const res = await uploadPhoto(editingPlace.id, blob);
      mark.remove();
      if (res) {
        editingPlace.photos.push({ id: res.photo.id, mime: res.photo.mime, bytes: res.photo.bytes });
        renderThumbs();
      }
    } else {
      pendingPhotos.push(blob);
      renderThumbs();
    }
  }
  if (editingPlace) {
    const data = await act(() => api("/trips/" + state.trip.trip.id));
    if (data) { state.trip = data; renderTrip(); }
  }
});

function addUploadingThumb(blob) {
  const t = el("div", "thumb up");
  const img = el("img");
  img.src = URL.createObjectURL(blob);
  t.append(img);
  $("pdThumbs").append(t);
  return t;
}

function renderThumbs() {
  const box = $("pdThumbs");
  box.textContent = "";
  const saved = editingPlace?.photos || [];
  saved.forEach(ph => {
    const t = el("div", "thumb");
    const img = el("img");
    img.alt = "";
    photoUrl(ph.id).then(u => { if (u) img.src = u; });
    img.onclick = () => openViewer(saved, saved.indexOf(ph));
    const rm = el("button", "rm");
    rm.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
    rm.title = "Удалить фото";
    rm.onclick = async () => {
      const ok = await act(() => api("/photos/" + ph.id, { method: "DELETE" }), "Фото удалено");
      if (!ok) return;
      editingPlace.photos = editingPlace.photos.filter(x => x.id !== ph.id);
      renderThumbs();
      const data = await act(() => api("/trips/" + state.trip.trip.id));
      if (data) { state.trip = data; renderTrip(); }
    };
    t.append(img, rm);
    box.append(t);
  });
  pendingPhotos.forEach((blob, i) => {
    const t = el("div", "thumb");
    const img = el("img");
    img.src = URL.createObjectURL(blob);
    const rm = el("button", "rm");
    rm.innerHTML = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', "icon xs");
    rm.onclick = () => { pendingPhotos.splice(i, 1); renderThumbs(); };
    t.append(img, rm);
    box.append(t);
  });
  $("pdPhotoHint").hidden = saved.length + pendingPhotos.length > 0;
}

/**
 * Картинку нельзя просто подставить в <img src>: файл отдаётся по токену, а
 * тег заголовок Authorization не шлёт. Поэтому качаем через auth.fetch и
 * держим objectURL в кэше — иначе каждая перерисовка списка тянула бы файлы заново.
 */
const photoCache = new Map();
function photoUrl(id) {
  if (!photoCache.has(id)) {
    photoCache.set(id, (async () => {
      try {
        const res = await auth.fetch("/api/photos/" + id);
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      } catch { return null; }
    })());
  }
  return photoCache.get(id);
}

function photoStrip(place) {
  const box = el("div", "p-photos");
  const shown = place.photos.slice(0, 4);
  shown.forEach((ph, i) => {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    photoUrl(ph.id).then(u => { if (u) img.src = u; });
    img.onclick = e => { e.stopPropagation(); openViewer(place.photos, i); };
    box.append(img);
  });
  if (place.photos.length > shown.length) {
    const more = el("button", "more", `+${place.photos.length - shown.length}`);
    more.onclick = e => { e.stopPropagation(); openViewer(place.photos, shown.length); };
    box.append(more);
  }
  return box;
}

// ───────────────────────── калькулятор ─────────────────────────
/**
 * Перенесён из «Моих финансов». Нужен ровно там же, где и там: посчитать
 * «4 780 на троих» посреди ввода суммы, не выходя из диалога.
 */
let calcExpr = "", calcTarget = null;

function openCalc(inputId) {
  calcTarget = inputId;
  const cur = parseFloat(String($(inputId).value).replace(",", ".").replace(/\s/g, ""));
  calcExpr = Number.isFinite(cur) && cur > 0 ? String(cur) : "";
  $("calcDisplay").textContent = calcExpr || "0";
  openScrim("calcScrim");
}

$("calcScrim").addEventListener("click", e => {
  const b = e.target.closest("[data-calc]");
  if (!b) return;
  const ch = b.dataset.calc;
  if (ch === "C") calcExpr = "";
  else if (ch === "back") calcExpr = calcExpr.slice(0, -1);
  else if (ch === "=") {
    const r = evalCalc(calcExpr);
    if (!Number.isFinite(r)) return snack("Проверьте выражение");
    calcExpr = String(Math.round(r * 100) / 100);
  } else if ("+-×÷".includes(ch)) {
    if (!calcExpr) return;                                   // выражение не начинается с операции
    calcExpr = /[+\-×÷]$/.test(calcExpr) ? calcExpr.slice(0, -1) + ch : calcExpr + ch;
  } else if (ch === ".") {
    const lastNum = calcExpr.split(/[+\-×÷]/).pop();
    if (!lastNum.includes(".")) calcExpr += (lastNum ? "" : "0") + ".";
  } else calcExpr += ch;
  $("calcDisplay").textContent = calcExpr || "0";
});

/** Разбор простого выражения без eval: умножение и деление вперёд сложения. */
function evalCalc(expr) {
  const tokens = String(expr || "").match(/(\d+\.?\d*|\.\d+)|[+\-×÷]/g);
  if (!tokens || !Number.isFinite(parseFloat(tokens[0]))) return NaN;
  const vals = [parseFloat(tokens[0])], ops = [];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i], num = parseFloat(tokens[i + 1]);
    if (!Number.isFinite(num)) return NaN;
    if (op === "×" || op === "÷") vals.push(op === "×" ? vals.pop() * num : vals.pop() / num);
    else { ops.push(op); vals.push(num); }
  }
  let result = vals[0];
  for (let i = 0; i < ops.length; i++) result = ops[i] === "+" ? result + vals[i + 1] : result - vals[i + 1];
  return result;
}

$("calcOkBtn").onclick = () => {
  let r = evalCalc(calcExpr);
  if (!Number.isFinite(r)) return snack("Проверьте выражение");
  if (r < 0) { snack("Результат отрицательный — поставил 0"); r = 0; }
  const input = $(calcTarget);
  input.value = String(Math.round(r * 100) / 100);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeScrim("calcScrim");
};
$("pdCalcBtn").onclick = () => openCalc("pdCost");
$("payCalcBtn").onclick = () => openCalc("payAmount");

// ───────────────────────── просмотр фото ─────────────────────────
let viewerList = [], viewerAt = 0;

async function openViewer(list, index) {
  viewerList = list; viewerAt = index;
  openScrim("photoScrim");
  await showViewerPhoto();
}
async function showViewerPhoto() {
  const ph = viewerList[viewerAt];
  if (!ph) return closeScrim("photoScrim");
  $("photoImg").src = (await photoUrl(ph.id)) || "";
  $("photoCaption").textContent = `${viewerAt + 1} из ${viewerList.length}`;
  $("photoPrev").hidden = viewerList.length < 2;
  $("photoNext").hidden = viewerList.length < 2;
}
$("photoPrev").onclick = () => { viewerAt = (viewerAt - 1 + viewerList.length) % viewerList.length; showViewerPhoto(); };
$("photoNext").onclick = () => { viewerAt = (viewerAt + 1) % viewerList.length; showViewerPhoto(); };
$("photoDeleteBtn").onclick = async () => {
  const ph = viewerList[viewerAt];
  const ok = await act(() => api("/photos/" + ph.id, { method: "DELETE" }), "Фото удалено");
  if (!ok) return;
  viewerList.splice(viewerAt, 1);
  photoCache.delete(ph.id);
  if (!viewerList.length) closeScrim("photoScrim"); else { viewerAt %= viewerList.length; showViewerPhoto(); }
  const data = await act(() => api("/trips/" + state.trip.trip.id));
  if (data) { state.trip = data; renderTrip(); if (editingPlace) { editingPlace = state.trip.places.find(p => p.id === editingPlace.id); renderThumbs(); } }
};
addEventListener("keydown", e => {
  if (!$("photoScrim").classList.contains("open")) return;
  if (e.key === "ArrowLeft") $("photoPrev").click();
  if (e.key === "ArrowRight") $("photoNext").click();
});

// ───────────────────────── карты и маршруты ─────────────────────────
/**
 * Тот же разбор, что и на сервере, но в браузере: ссылка обычно содержит
 * координаты прямо в адресе, и ради них нет смысла ходить на сервер. Серверная
 * версия нужна только для коротких ссылок-редиректов.
 *
 * Порядок координат у сервисов разный — у Яндекса в ll/pt «долгота,широта»,
 * у Google везде «широта,долгота». Это главный источник ошибок в таком коде.
 */
function parseGeoClient(raw) {
  const s = String(raw || "").trim();
  const bare = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (bare) return okPoint(+bare[1], +bare[2]);

  let u;
  try { u = new URL(s.startsWith("http") ? s : "https://" + s); } catch { return null; }
  const host = u.hostname.replace(/^www\./, ""), q = u.searchParams;
  const pair = (v, order) => {
    const m = String(v || "").match(/(-?\d{1,3}(?:\.\d+)?)[,%2C]+(-?\d{1,3}(?:\.\d+)?)/i);
    if (!m) return null;
    return order === "latlon" ? okPoint(+m[1], +m[2]) : okPoint(+m[2], +m[1]);
  };

  if (/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/.test(host)) {
    for (const k of ["whatshere[point]", "pt", "ll"]) { const hit = pair(q.get(k), "lonlat"); if (hit) return hit; }
    const rt = pair((q.get("rtext") || "").split("~").pop(), "latlon");
    if (rt) return rt;
  }
  if (/(^|\.)google\.[a-z.]+$/.test(host)) {
    const at = u.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (at) return okPoint(+at[1], +at[2]);
    const d34 = u.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (d34) return okPoint(+d34[1], +d34[2]);
    for (const k of ["q", "query", "ll", "center", "destination"]) { const hit = pair(q.get(k), "latlon"); if (hit) return hit; }
  }
  if (/(^|\.)2gis\.[a-z.]+$/.test(host)) {
    for (const k of ["m", "queryState"]) { const hit = pair(q.get(k), "lonlat"); if (hit) return hit; }
    const geo = u.pathname.match(/(-?\d{1,3}\.\d+)(?:%2C|,)(-?\d{1,3}\.\d+)/i);
    if (geo) return pair(geo[0], "lonlat");
  }
  if (/(^|\.)(openstreetmap\.org|osm\.org)$/.test(host)) {
    const ml = okPoint(+q.get("mlat"), +q.get("mlon"));
    if (ml) return ml;
    const m = u.hash.match(/map=[\d.]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (m) return okPoint(+m[1], +m[2]);
  }
  if (host === "maps.apple.com") {
    for (const k of ["ll", "sll", "q", "daddr"]) { const hit = pair(q.get(k), "latlon"); if (hit) return hit; }
  }
  const any = u.href.match(/(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/);
  return any ? okPoint(+any[1], +any[2]) : null;
}
function okPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

const pointUrl = p => `https://yandex.ru/maps/?pt=${p.lon},${p.lat}&z=17&l=map`;

function yandexRoute(points, mode) {
  const rtt = { auto: "auto", pedestrian: "pd", transit: "mt" }[mode] || "auto";
  // Одна точка: пустой первый пункт означает «отсюда», Яндекс сам спросит геолокацию.
  const rtext = (points.length === 1 ? [""] : []).concat(points.map(p => `${p.lat},${p.lon}`)).join("~");
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`;
}
function googleRoute(points, mode) {
  const travelmode = { auto: "driving", pedestrian: "walking", transit: "transit" }[mode] || "driving";
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  const last = points[points.length - 1];
  u.searchParams.set("destination", `${last.lat},${last.lon}`);
  if (points.length > 1) {
    u.searchParams.set("origin", `${points[0].lat},${points[0].lon}`);
    const mid = points.slice(1, -1);
    if (mid.length) u.searchParams.set("waypoints", mid.map(p => `${p.lat},${p.lon}`).join("|"));
  }
  // origin не задан → Google строит маршрут от текущего местоположения.
  u.searchParams.set("travelmode", travelmode);
  return u.href;
}

let routeDay = null, routeMode = "auto";

/** Маршрут всегда строится по дню целиком: клик на «Маршрут» у конкретного
    места просто открывает диалог на его дне. Вести «только к этой точке» из
    середины дня — почти всегда не то, что человек имел в виду, а если точка в
    дне одна, так и получится само. */
function openRouteDialog(day) {
  routeDay = day ?? null;

  const days = [...new Set(state.trip.places.filter(p => p.lat != null).map(p => p.day || ""))]
    .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  const sel = $("rtDay");
  sel.textContent = "";
  for (const d of days) {
    const o = el("option", null, d ? dayFmt.format(parseDay(d)) : "Без даты");
    o.value = d;
    sel.append(o);
  }
  const all = el("option", null, "Все точки поездки");
  all.value = "*";
  sel.append(all);
  sel.value = days.includes(routeDay ?? "") ? (routeDay ?? "") : (days[0] ?? "*");
  routeDay = sel.value;
  sel.onchange = () => { routeDay = sel.value; renderRoutePoints(); };

  $("rtMode").querySelectorAll("button").forEach(b => b.classList.toggle("sel", b.dataset.mode === routeMode));
  renderRoutePoints();
  openScrim("routeScrim");
}

$("rtMode").addEventListener("click", e => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  routeMode = b.dataset.mode;
  $("rtMode").querySelectorAll("button").forEach(x => x.classList.toggle("sel", x === b));
});

function routePoints() {
  return state.trip.places
    .filter(p => p.lat != null)
    .filter(p => routeDay === "*" || (p.day || "") === routeDay)
    .sort((a, b) => (a.timeFrom || "99:99").localeCompare(b.timeFrom || "99:99") || a.sortOrder - b.sortOrder);
}

function renderRoutePoints() {
  const box = $("rtPoints");
  box.textContent = "";
  const pts = routePoints();
  pts.forEach((p, i) => {
    const row = el("div", "rp" + (p.done ? " off" : ""));
    row.innerHTML = `<span class="n">${i + 1}</span><span>${esc(p.title)}</span>`;
    box.append(row);
  });
  if (pts.length === 1) {
    box.append(Object.assign(el("div", "hint"), { textContent: "Точка одна — маршрут построится от вашего местоположения, карты спросят разрешение." }));
  }
  if (!pts.length) {
    box.append(Object.assign(el("div", "hint"), { textContent: "В этом дне нет мест с координатами. Вставьте в место ссылку с карты — точка появится здесь." }));
  }
  $("rtYandexBtn").disabled = !pts.length;
  $("rtGoogleBtn").disabled = !pts.length;
}

$("rtYandexBtn").onclick = () => { const p = routePoints(); if (p.length) window.open(yandexRoute(p, routeMode), "_blank", "noopener"); };
$("rtGoogleBtn").onclick = () => { const p = routePoints(); if (p.length) window.open(googleRoute(p, routeMode), "_blank", "noopener"); };
$("routeAllBtn").onclick = () => openRouteDialog("*");

// ───────────────────────── приглашение ─────────────────────────
const inviteUrl = code => `${location.origin}${location.pathname}#/join/${code}`;

$("shareBtn").onclick = () => openShareDialog();

function openShareDialog() {
  const trip = state.trip.trip;
  const code = trip.joinCode;
  $("shareUrl").value = code ? inviteUrl(code) : "доступ по ссылке закрыт";
  $("shareCode").textContent = code || "—";
  $("shareRevokeBtn").hidden = !code;
  $("shareRenewBtn").textContent = code ? "Новая ссылка" : "Открыть доступ";
  $("shareCopyBtn").disabled = !code;
  const owner = trip.myRole === "owner";
  $("shareRevokeBtn").hidden = !owner || !code;
  $("shareRenewBtn").hidden = !owner;
  openScrim("shareScrim");
}

$("shareCopyBtn").onclick = async () => {
  const url = $("shareUrl").value;
  try { await navigator.clipboard.writeText(url); snack("Ссылка скопирована"); }
  catch { $("shareUrl").select(); snack("Скопируйте ссылку вручную"); }
};
$("shareRenewBtn").onclick = async () => {
  const res = await act(() => api(`/trips/${state.trip.trip.id}/code`, { method: "POST" }), "Ссылка обновлена");
  if (!res) return;
  state.trip.trip.joinCode = res.joinCode;
  openShareDialog();
};
$("shareRevokeBtn").onclick = () => {
  confirmDialog("Закрыть доступ по ссылке?", "Старая ссылка перестанет работать. Те, кто уже присоединился, останутся в поездке.", "Закрыть", async () => {
    const res = await act(() => api(`/trips/${state.trip.trip.id}/code`, { method: "DELETE" }), "Доступ закрыт");
    if (!res) return;
    state.trip.trip.joinCode = null;
    openShareDialog();
  });
};

async function showJoin(code) {
  showOnly("joinView");
  const info = await act(() => api("/invite/" + code));
  if (!info) { $("joinTitle").textContent = "Приглашение не найдено"; $("joinMeta").textContent = "Ссылка устарела или доступ по ней закрыли. Попросите новую у того, кто вас позвал."; $("joinBtn").hidden = true; return; }

  $("joinTitle").textContent = info.title;
  $("joinMeta").innerHTML = [
    info.destination ? esc(info.destination) : "",
    esc(dateRange(info.startsOn, info.endsOn)),
    info.members.length ? `Уже едут: ${esc(info.members.join(", "))}` : "",
  ].filter(Boolean).join("<br>");
  $("joinBtn").hidden = false;
  $("joinBtn").textContent = info.alreadyMember ? "Открыть поездку" : "Присоединиться";
  $("joinBtn").onclick = async () => {
    const res = await act(() => api(`/invite/${code}/join`, { method: "POST" }), info.alreadyMember ? null : "Вы в поездке");
    if (res) location.hash = "#/t/" + res.tripId;
  };
}

// ───────────────────────── поехали ─────────────────────────
init().catch(e => {
  console.error(e);
  showAuthScreen("Не получилось открыть сервис", "Сервер не отвечает — обновите страницу. Если не помогает, попробуйте войти заново.");
});
