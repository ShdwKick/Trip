/**
 * Проверки арифметики распознавания чека (gigachat.js): сверка суммы с итогом
 * и разворачивание «Ньокки × 2» в отдельные порции. Сеть не трогаем — модель
 * тут ни при чём, оба шага чисто вычислительные и детерминированные.
 *
 * Запуск: node test/gigachat.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { checkBill } = require(path.resolve(fileURLToPath(import.meta.url), "../../gigachat.js"));

let failures = 0;
function ok(name, cond, extra = "") {
  console.log(`${cond ? "  OK  " : " FAIL "} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

/* ---------- 1. Без гостя — количество разворачивается в порции ---------- */
{
  const r = checkBill({
    items: [{ title: "Ньокки", amount: 800, qty: 2, unitPrice: 400, guest: null }],
    total: 800,
  });
  ok("две порции вместо одной строки", r.items.length === 2, JSON.stringify(r.items));
  ok("портии равны и помечены", r.items.every(i => i.amount === 400) && r.items[0].portion?.of === 2);
  ok("сумма сходится с итогом", r.matches);
}

/* ---------- 2. С гостем — количество остаётся одной строкой ---------- */
// Ключевая проверка новой логики: раз гость уже известен, дробить количество
// незачем — назначать позицию ещё раз по порциям было бы лишним действием.
{
  const r = checkBill({
    items: [{ title: "Ньокки", amount: 800, qty: 2, unitPrice: 400, guest: "Гость 1" }],
    total: 800,
  });
  ok("ОДНА СТРОКА, А НЕ ДВЕ ПОРЦИИ", r.items.length === 1, JSON.stringify(r.items));
  ok("количество и сумма сохранены как есть", r.items[0].qty === 2 && r.items[0].amount === 800);
  ok("метка гостя сохранена", r.items[0].guest === "Гость 1");
  ok("сумма всё равно сходится", r.matches);
}

/* ---------- 3. Гости не мешают дробить чужие безымянные позиции рядом ---------- */
{
  const r = checkBill({
    items: [
      { title: "Ньокки", amount: 800, qty: 2, unitPrice: 400, guest: "Гость 1" },
      { title: "Пиво", amount: 600, qty: 2, unitPrice: 300, guest: null },
    ],
    total: 1400,
  });
  ok("позиция гостя не дробится, соседняя без гостя — дробится", r.items.length === 3, JSON.stringify(r.items));
  ok("сумма по-прежнему сходится", r.matches);
}

/* ---------- 4. Неровное количество не дробится, даже без гостя ---------- */
{
  const r = checkBill({
    items: [{ title: "Хинкали", amount: 1000, qty: 3, unitPrice: null, guest: null }],
    total: 1000,
  });
  ok("1000/3 не делится ровно — строка одна", r.items.length === 1 && r.items[0].amount === 1000);
}

console.log(failures ? `\n${failures} упало.` : "\nАрифметика чека: всё сошлось.");
process.exit(failures ? 1 : 0);
