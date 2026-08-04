"use strict";
/**
 * Разбор чека.
 *
 *   parseReceipt(text) → { items: [{title, amount, qty}], skipped }
 *
 * На вход идёт текст, вставленный человеком, — либо, когда появится
 * распознавание на сервере, строки от него. Разница одна, но важная:
 * распознавание видит, где на бумаге были широкие пробелы между колонками, и
 * может отметить их табуляцией; такие строки разбираются точнее.
 *
 * Зачем это нужно. В настоящем ресторанном чеке есть колонка «Кол-во»:
 *
 *     Завтрак Папа может          1     790.00
 *     Итого к оплате Гость 1:         1 280.00
 *
 * По тексту эти две строки неразличимы: «1 790.00» — это либо количество и
 * сумма, либо тысяча семьсот девяносто. Отличает их только расстояние между
 * числами: между колонками пробел широкий, внутри разряда тысяч — обычный.
 * Поэтому колонки размечаются на этапе распознавания, а здесь читаются как
 * готовые поля. Без табуляций (вставленный текст) работает прежняя логика с
 * последним числом в строке — она угадывает верно в большинстве случаев.
 */

(function (root) {
  // \b в JS работает только по латинице, поэтому границу слова для кириллицы
  // задаём явно — иначе «ИТОГО:» не отсеивается и попадает в позиции.
  const SERVICE = new RegExp("^(" + [
    // итоги и оплата
    "итого", "итог", "всего", "сумма", "к оплате", "оплата", "наличными", "наличные",
    "картой", "безналичными", "электронными", "сдача", "ндс", "без ндс", "скидка",
    "предоплата", "округление", "чаевые",
    // шапка и подвал чека
    "инн", "кпп", "фн", "фд", "фп", "фпд", "рн ккт", "ккт", "смена", "кассир", "чек",
    "номер чека", "тел", "сайт", "адрес", "спасибо", "онлайн-касса", "атол", "эвотор",
    "гостевой", "гость", "зал", "стол", "заказ", "официант", "открыт", "закрыт",
    "наименование", "кол-во", "количество", "цена", "отсканируйте", "сберчаевые",
    "приятного", "ооо", "ип ", "предприятиям",
    // латиница
    "total", "subtotal", "sum", "amount due", "cash", "card", "change", "vat", "tax",
    "tip", "service", "discount", "guest", "table", "qty", "item",
  ].join("|") + ")(?![а-яёa-z])", "i");

  const toNum = s => parseFloat(String(s).replace(/[    ]/g, "").replace(",", "."));
  const isNum = s => /^\d[\d    ]*(?:[.,]\d{1,2})?$/.test(String(s).trim());
  const clean = s => String(s || "").trim().replace(/[.\-–—:_\s]+$/, "").replace(/^[.\-–—:_\s]+/, "");

  const NUM = "\\d[\\d\\u00a0\\u2007\\u202f ]*(?:[.,]\\d{1,2})?";
  const QTY_UNIT_TOTAL = new RegExp(`^(.*?)\\s*(\\d+(?:[.,]\\d+)?)\\s*[x×хX*]\\s*(${NUM})\\s+(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");
  const QTY_UNIT = new RegExp(`^(.*?)\\s*(\\d+(?:[.,]\\d+)?)\\s*[x×хX*]\\s*(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");
  const TAIL = new RegExp(`^(.*?)[\\s.\\-–—:]*(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");

  /**
   * Строка, размеченная по колонкам: «название \t кол-во \t сумма».
   * Последнее числовое поле — сумма, предыдущее целое — количество.
   */
  function parseColumns(line) {
    const cells = line.split("\t").map(s => s.trim()).filter(Boolean);
    if (cells.length < 2) return undefined;   // колонок нет, разбираем как обычный текст

    let sumAt = -1;
    for (let i = cells.length - 1; i > 0; i--) if (isNum(cells[i])) { sumAt = i; break; }
    if (sumAt <= 0) return undefined;

    const amount = toNum(cells[sumAt]);
    let qty = null;
    if (sumAt - 1 > 0 && isNum(cells[sumAt - 1])) qty = toNum(cells[sumAt - 1]);
    const title = clean(cells.slice(0, qty === null ? sumAt : sumAt - 1).join(" "));
    if (!title || !Number.isFinite(amount)) return null;
    return { title, amount, qty };
  }

  // «… 1  790.00» — количество отдельным столбцом и сумма с копейками.
  const QTY_SUM = new RegExp(`^(.*?[а-яёa-z].*?)\\s+(\\d{1,3})\\s+(\\d[\\d\\u00a0 ]*[.,]\\d{2})\\s*(?:₽|руб\\.?|р\\.?)?$`, "i");

  function parseLine(raw, qtyColumn) {
    const line = raw.replace(/\t/g, " ").trim();
    if (SERVICE.test(line)) return null;

    // Если по чеку видно, что колонка количества есть, читаем её явно: иначе
    // «1 790.00» станет тысячей семьюстами девяноста вместо одной штуки за 790.
    if (qtyColumn) {
      const q = line.match(QTY_SUM);
      if (q) return { title: clean(q[1]), amount: toNum(q[3]), qty: toNum(q[2]) };
    }

    let m = line.match(QTY_UNIT_TOTAL);
    if (m) return { title: clean(m[1]), amount: toNum(m[4]), qty: toNum(m[2]) };

    m = line.match(QTY_UNIT);
    if (m) {
      const qty = toNum(m[2]), unit = toNum(m[3]);
      return { title: clean(m[1]), amount: Math.round(qty * unit * 100) / 100, qty };
    }

    m = line.match(TAIL);
    if (!m) return null;
    const amount = toNum(m[2]);
    const title = clean(m[1]);
    if (!title || !Number.isFinite(amount)) return null;

    // Длинное целое без копеек — это не цена, а ИНН, номер чека или карта.
    if (!/[.,]/.test(m[2]) && m[2].replace(/\D/g, "").length >= 8) return null;
    if (!/[а-яёa-z]/i.test(title)) return null;

    return { title, amount, qty: null };
  }

  /**
   * Есть ли в чеке колонка количества. Решаем по чеку целиком, а не построчно:
   * одна строка «Салат 1 350.00» неотличима от «Салат 1 350,00 ₽», а вот когда
   * так выглядит половина чека — это колонка, и читать её надо как колонку.
   */
  function hasQtyColumn(lines) {
    let candidates = 0, withQty = 0;
    for (const line of lines) {
      const flat = line.replace(/\t/g, " ").trim();
      if (!flat || SERVICE.test(flat) || !/\d/.test(flat) || !/[а-яёa-z]/i.test(flat)) continue;
      candidates++;
      if (QTY_SUM.test(flat)) withQty++;
    }
    return withQty >= 2 && withQty * 2 >= candidates;
  }

  function parseReceipt(text) {
    const items = [];
    let skipped = 0;
    const allLines = String(text || "").split(/\r?\n/);
    const qtyColumn = hasQtyColumn(allLines);

    for (const raw of allLines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) continue;

      const flat = line.replace(/\t/g, " ").trim();
      if (SERVICE.test(flat)) { skipped++; continue; }

      // Названия длиннее строки печатаются с переносом, и продолжение остаётся
      // без числа: «Сырники с вареньем из Владимирск» / «ой вишни». Такую
      // строку приклеиваем к предыдущей позиции — иначе половина названия
      // теряется, а обрывок уходит в мусор.
      const hasDigits = /\d/.test(flat);
      if (!hasDigits && items.length) {
        const prev = items[items.length - 1];
        // Перенос слова склеиваем без пробела, отдельное слово — с пробелом.
        prev.title = (prev.title + (/[а-яё]$/i.test(prev.title) && /^[а-яё]/.test(flat) && flat.length <= 12 ? "" : " ") + flat.trim()).slice(0, 200);
        continue;
      }

      const columns = parseColumns(line);
      const item = columns === undefined ? parseLine(line, qtyColumn) : columns;
      if (!item || !Number.isFinite(item.amount) || !item.title) { skipped++; continue; }
      items.push({ title: item.title.slice(0, 200), amount: Math.round(item.amount * 100) / 100, qty: item.qty });
    }
    return { items, skipped };
  }

  root.parseReceipt = parseReceipt;
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) module.exports = { parseReceipt: globalThis.parseReceipt };
