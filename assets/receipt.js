"use strict";
/**
 * Разбор чека, вставленного текстом.
 *
 *   parseReceipt(text) → { items: [{title, amount, qty}], skipped }
 *
 * Чек — это не таблица, а печатный текст, и универсального формата у него нет.
 * Поэтому разбор построен на правилах, которые верны для большинства чеков, а
 * всё сомнительное лучше пропустить, чем угадать: пропущенную строку человек
 * увидит и допишет сам, а тихо переставленная цена всплывёт только при расчёте.
 *
 * Правила, по убыванию силы:
 *   1. «2 x 445,00  890,00» — количество, цена за штуку и сумма. Берём сумму.
 *   2. «3 х 180» — количество и цена за штуку без суммы. Берём произведение.
 *   3. Иначе последнее число в строке — это сумма позиции.
 *
 * Служебные строки (ИТОГО, НДС, ИНН, номер чека) отбрасываются: в списке
 * позиций им не место, а «ИТОГО» ещё и удвоило бы счёт.
 */

(function (root) {
  // \b в JS работает только по латинице, поэтому границу слова для кириллицы
  // задаём явно — иначе «ИТОГО:» не отсеивается и попадает в позиции.
  const SERVICE = /^(итого|итог|всего|сумма|к оплате|оплата|наличными|наличные|картой|безналичными|электронными|сдача|ндс|без ндс|скидка|округление|инн|кпп|фн|фд|фп|фпд|рн ккт|ккт|смена|кассир|чек|номер чека|тел|сайт|адрес|спасибо|total|subtotal|sum|amount due|cash|card|change|vat|tax|tip|service|discount)(?![а-яёa-z])/i;

  const NUM = "\\d[\\d\\u00a0\\u2007\\u202f ]*(?:[.,]\\d{1,2})?";
  const toNum = s => parseFloat(String(s).replace(/[    ]/g, "").replace(",", "."));
  const QTY_UNIT_TOTAL = new RegExp(`^(.*?)\\s*(\\d+(?:[.,]\\d+)?)\\s*[x×хX*]\\s*(${NUM})\\s+(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");
  const QTY_UNIT = new RegExp(`^(.*?)\\s*(\\d+(?:[.,]\\d+)?)\\s*[x×хX*]\\s*(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");
  const TAIL = new RegExp(`^(.*?)[\\s.\\-–—:]*(${NUM})\\s*(?:₽|руб\\.?|р\\.?|rub)?$`, "i");

  const clean = s => String(s || "").trim().replace(/[.\-–—:\s]+$/, "").replace(/^[.\-–—:\s]+/, "");

  function parseLine(line) {
    if (SERVICE.test(line)) return null;

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
    // Настоящая позиция в чеке столько не стоит, а спутать их легко.
    if (!/[.,]/.test(m[2]) && m[2].replace(/\D/g, "").length >= 8) return null;
    // Строка вида «2» или «шт» без названия — остаток разметки, не позиция.
    if (!/[а-яёa-z]/i.test(title)) return null;

    return { title, amount, qty: null };
  }

  function parseReceipt(text) {
    const items = [];
    let skipped = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const item = parseLine(line);
      if (!item || !Number.isFinite(item.amount) || !item.title) { skipped++; continue; }
      items.push({ title: item.title.slice(0, 200), amount: Math.round(item.amount * 100) / 100, qty: item.qty });
    }
    return { items, skipped };
  }

  root.parseReceipt = parseReceipt;
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) module.exports = { parseReceipt: globalThis.parseReceipt };
