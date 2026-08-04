/**
 * Прогон настоящих фотографий чеков через распознавание.
 *
 *   node test/scan-fixtures.mjs
 *
 * Не автотест: ходит в сеть, тратит токены и зависит от того, что вернёт модель.
 * Нужен для другого — измерить, что получается на живых чеках: сколько позиций,
 * сходится ли сумма с итогом и во сколько токенов обходится один чек.
 *
 * Ключ берётся из .dev/gigachat.env (в репозиторий не попадает), фотографии —
 * из test/fixtures. Ни то, ни другое не печатается.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

// Читаем ключ из файла, а не из аргументов: в истории команд ему не место.
const envFile = [
  path.join(ROOT, ".dev", "gigachat.env"),
  path.join(ROOT, ".dev", "trip", "gigachat.env"),
  path.join(ROOT, "gigachat.env"),
].find(fs.existsSync);
if (!envFile) {
  console.error(`Не нашёл файл с ключом. Ожидаю его в .dev/gigachat.env\nВнутри одна строка: GIGACHAT_AUTH_KEY=...`);
  process.exit(1);
}
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

/**
 * Домены Сбера подписаны корневым сертификатом Минцифры, которого нет ни в
 * наборе Node, ни в хранилище Windows по умолчанию — без него соединение
 * падает с невнятным «fetch failed». Node читает NODE_EXTRA_CA_CERTS только при
 * старте, поэтому если сертификат нашёлся, а переменной нет — перезапускаем
 * себя же с ней. Один запуск вместо двух и объяснения, почему «не работает».
 */
const certFile = [
  path.join(ROOT, ".dev", "russian_trusted_root_ca.pem"),
  path.join(ROOT, ".dev", "russian_trusted_root_ca.cer"),
  path.join(ROOT, ".dev", "trip", "russian_trusted_root_ca.pem"),
  path.join(ROOT, ".dev", "trip", "russian_trusted_root_ca.cer"),
  path.join(ROOT, "russian_trusted_root_ca.pem"),
].find(fs.existsSync);

if (certFile && !process.env.NODE_EXTRA_CA_CERTS) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile },
  });
  process.exit(r.status ?? 1);
}
if (!certFile) {
  console.log("Сертификат Минцифры не найден рядом — если соединение отвалится, положите russian_trusted_root_ca.pem в .dev/\n");
}

const { checkBill } = require(path.join(ROOT, "gigachat.js"));
const giga = require(path.join(ROOT, "gigachat.js"))({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  model: process.env.GIGACHAT_MODEL || "GigaChat-2-Pro",
});

const dir = path.join(ROOT, "test", "fixtures");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)) : [];
if (!files.length) {
  console.error(`Нет фотографий в ${dir}`);
  process.exit(1);
}

const money = v => (v == null ? "—" : v.toLocaleString("ru-RU") + " ₽");
let tokens = 0;

for (const file of files) {
  const buf = fs.readFileSync(path.join(dir, file));
  const mime = file.match(/\.png$/i) ? "image/png" : file.match(/\.webp$/i) ? "image/webp" : "image/jpeg";
  process.stdout.write(`\n=== ${file} (${(buf.length / 1024 | 0)} КБ) ===\n`);
  const started = Date.now();
  try {
    const { bill, usage } = await giga.readReceipt(buf, mime);
    const checked = checkBill(bill);
    tokens += usage?.total_tokens || 0;

    for (const item of checked.items) {
      const portion = item.portion ? ` (${item.portion.index}/${item.portion.of})` : "";
      const guest = item.guest ? `  [${item.guest}]` : "";
      console.log(`  ${String(money(item.amount)).padStart(12)}  ${item.title}${portion}${guest}${item.suspect ? "  ← не сходится" : ""}`);
    }
    console.log(`  ─────`);
    console.log(`  позиций: ${checked.items.length}, сумма: ${money(checked.sum)}, итог чека: ${money(checked.total)}`);
    console.log(`  ${checked.matches ? "СХОДИТСЯ" : `РАСХОЖДЕНИЕ: ${money(checked.diff)}`}`);
    console.log(`  время: ${((Date.now() - started) / 1000).toFixed(1)} с, токенов: ${usage?.total_tokens ?? "?"}`);
  } catch (e) {
    console.log(`  не удалось: ${e.message}`);
  }
}

console.log(`\nВсего токенов за ${files.length} чек(а/ов): ${tokens}` +
  (tokens ? `, в среднем ${Math.round(tokens / files.length)} на чек` : ""));
