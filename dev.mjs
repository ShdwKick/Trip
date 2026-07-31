#!/usr/bin/env node
/**
 * Локальный запуск одной командой:
 *
 *   node dev.mjs            поднять auth и сервис, всё настроив
 *   node dev.mjs --reset    начать с чистых данных
 *
 * Что делает: заводит отдельные базы в .dev/, регистрирует в auth клиента
 * `trip` с адресом возврата http://localhost:8790/, создаёт тестовый аккаунт и
 * запускает оба сервиса. Дальше открываете http://localhost:8790 и входите.
 *
 * Почему нельзя просто открыть index.html или отдать папку Live Server'ом:
 *
 *   1. Это не статика. Данные, проверка токена и отдача фотографий живут в
 *      server.js — без него страница получит 401 на первом же запросе.
 *   2. redirect_uri сверяется в auth ПОБАЙТОВО. Live Server отдаёт на порту
 *      5500, а зарегистрирован адрес :8790 — вход отобьётся ещё до формы.
 *   3. Кука сессии auth помечена Secure и по http:// браузером не сохраняется.
 *      Поэтому auth здесь запускается с DEV=1: без него логин проходит, а
 *      обратно возвращает будто ничего не было. Именно так это и выглядит,
 *      когда «страницу входа не пройти».
 *
 * Аккаунт по умолчанию — dev / dev-parol-2026, меняется переменными
 * DEV_LOGIN и DEV_PASSWORD.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const TRIP_DIR = path.resolve(fileURLToPath(import.meta.url), "..");
const AUTH_DIR = process.env.AUTH_DIR || path.join(TRIP_DIR, "..", "Auth");
const WORK = path.join(TRIP_DIR, ".dev");
const AUTH_PORT = 8788, TRIP_PORT = 8790;
const AUTH = `http://localhost:${AUTH_PORT}`;
const TRIP = `http://localhost:${TRIP_PORT}`;
const LOGIN = process.env.DEV_LOGIN || "dev";
const PASSWORD = process.env.DEV_PASSWORD || "dev-parol-2026";

// node:sqlite до 24-й версии живёт под флагом. Проверять версию тут дешевле,
// чем объяснять в README, почему «у меня падает на ERR_UNKNOWN_BUILTIN_MODULE».
const major = parseInt(process.versions.node.split(".")[0], 10);
const NODE_ARGS = major < 24 ? ["--experimental-sqlite"] : [];
if (major < 22) {
  console.error(`Нужен Node 22 или новее, у вас ${process.versions.node}.`);
  process.exit(1);
}

if (!fs.existsSync(path.join(AUTH_DIR, "server.js"))) {
  console.error(`Не нашёл auth-сервис в ${AUTH_DIR}.\nОн должен лежать рядом: BurningHouse/Auth. Или укажите путь: AUTH_DIR=... node dev.mjs`);
  process.exit(1);
}

if (process.argv.includes("--reset")) {
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log("Данные .dev удалены — начинаем с нуля.\n");
}
fs.mkdirSync(path.join(WORK, "auth"), { recursive: true });
fs.mkdirSync(path.join(WORK, "trip"), { recursive: true });

for (const [url, port] of [[AUTH, AUTH_PORT], [TRIP, TRIP_PORT]]) {
  try {
    await fetch(url + "/api/health", { signal: AbortSignal.timeout(700) });
    console.error(`Порт ${port} уже занят — остановите тот процесс и повторите.`);
    process.exit(1);
  } catch { /* свободен, продолжаем */ }
}

/* ---------- настройка auth ---------- */
const authEnv = { ...process.env, DATA_DIR: path.join(WORK, "auth") };
function authCli(...args) {
  try {
    return execFileSync("node", [...NODE_ARGS, "server.js", ...args], { cwd: AUTH_DIR, env: authEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return String(e.stdout || "") + String(e.stderr || "");   // «логин занят» — не ошибка, повторный запуск это норма
  }
}
authCli("client-add", "trip", "Куда поедем?", TRIP + "/");
authCli("adduser", LOGIN, PASSWORD);

/* ---------- запуск ---------- */
const procs = [];
function start(name, cwd, env, color) {
  const p = spawn("node", [...NODE_ARGS, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const print = d => String(d).split("\n").filter(Boolean)
    .filter(l => !l.includes("ExperimentalWarning") && !l.includes("--trace-warnings"))
    .forEach(l => console.log(`${color}${name}\x1b[0m  ${l}`));
  p.stdout.on("data", print);
  p.stderr.on("data", print);
  p.on("exit", code => { if (code) console.error(`${name} завершился с кодом ${code}`); });
  procs.push(p);
}
start("auth", AUTH_DIR, {
  ...authEnv,
  DEV: "1",                    // без этого кука сессии не переживёт http:// — см. шапку файла
  ISSUER: AUTH, PORT: String(AUTH_PORT), HOST: "127.0.0.1",
}, "\x1b[33m");
start("trip", TRIP_DIR, {
  ...process.env,
  DATA_DIR: path.join(WORK, "trip"),
  PORT: String(TRIP_PORT), HOST: "127.0.0.1",
  AUTH_ISSUER: AUTH, AUTH_CLIENT_ID: "trip",
}, "\x1b[36m");

console.log(`
  Открывайте:  ${TRIP}
  Аккаунт:     ${LOGIN} / ${PASSWORD}

  Второго участника (проверить приглашение) заводят так же — на странице входа
  есть «Зарегистрироваться», либо в другом браузере/приватном окне.

  Ctrl+C — остановить оба сервиса. Данные лежат в .dev/ и не коммитятся.
`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { for (const p of procs) p.kill(); process.exit(0); });
}
