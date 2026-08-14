"use strict";
/**
 * Распознавание чека через GigaChat.
 *
 *   const giga = require("./gigachat")({ authKey, scope, model, caFile });
 *   const bill = await giga.readReceipt(buffer, "image/jpeg");
 *
 * Почему модель, а не OCR. Мы пробовали читать чек по буквам — и локально, и с
 * разметкой колонок по координатам. Упирается всё не в чтение символов, а в
 * раскладку: в четырёх настоящих чеках оказалось три разных, причём в одном
 * числа напечатаны строкой ВЫШЕ своих названий. Правилами это не берётся,
 * а модель, которая видит чек целиком, справляется.
 *
 * Ключ живёт только в окружении сервера. В браузер он не попадает никогда:
 * фотография уходит на наш бэкенд, дальше в Сбер ходит он.
 */

const crypto = require("crypto");

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const API_BASE = "https://gigachat.devices.sberbank.ru/api/v1";

/**
 * Что просим у модели. Правила выписаны по разбору настоящих ответов: без
 * пункта про «цена × количество» модель на чеке вида `790.00*2 шт. =1580.00`
 * возвращала 790 вместо 1580, а без запрета объединять — склеивала две
 * соседние позиции в одну и теряла третью.
 */
const PROMPT = `Ты разбираешь фотографию ресторанного счёта.

Верни СТРОГО JSON без пояснений, без markdown, без текста вокруг:
{"items":[{"title":"","qty":1,"unitPrice":null,"amount":0,"guest":null}],"total":null,"currency":"RUB"}

Правила:
1. title — название позиции ДОСЛОВНО, как напечатано. Не исправляй опечатки, не сокращай, не переводи. Если название перенесено на следующую строку — собери его целиком.
2. amount — итоговая сумма строки. Если в чеке указаны цена за единицу и количество (например «790.00*2» или «2 x 445.00 890.00»), то amount — именно итог строки, а не цена за штуку. Проверь: qty × unitPrice должно равняться amount.
3. unitPrice — цена за единицу. Если в чеке напечатана только сумма строки и количество, посчитай её делением и заполни обязательно: по ней позиция потом делится между людьми.
4. Не объединяй разные позиции в одну и не пропускай ни одной, включая строки с нулевой ценой.
5. НЕ включай в items: итоги («Итого», «ИТОГ», «Меню», «Сумма по…»), налоги, скидки, чаевые, номер стола, официанта, ИНН и прочие служебные строки.
6. total — итоговая сумма всего чека, как она напечатана («ИТОГО К ОПЛАТЕ», «ИТОГ»). Если её не видно — null.
7. guest — метка блока, если чек разбит по гостям («Гость 1», «Гость 2»). Иначе null. Важно: у всех позиций одного и того же гостя guest должен быть написан ОДИНАКОВО, символ в символ («Гость 1» везде, а не «Гость 1» в одной строке и «1» в другой) — по этому полю позиции потом группируют программно, и малейшее расхождение группу разрывает. Все позиции одного гостя верни подряд, одну группу за другой, не перемежая гостей.
8. Количество (qty) у позиции с guest — это то, сколько гость заказал, а не сигнал распределить между разными людьми: раз гость уже известен, дробить порции незачем, оставь такую позицию одной строкой с её реальным количеством.
9. Если какая-то цифра не читается — верни null в этом поле, не выдумывай. Название, которое не читается, тоже не додумывай: перепиши как видишь.`;

/**
 * Второй заход, когда сумма позиций не сошлась с итогом чека. Просто повторить
 * запрос бесполезно — при нулевой температуре модель детерминирована и выдаёт
 * тот же ответ (проверено: три прогона одного фото, два одинаковых до копейки).
 * А вот подсказка с найденным расхождением меняет условие задачи, и разбор
 * получается другим.
 */
const RETRY_PROMPT = (sum, total, diff) =>
  `Твой разбор дал сумму позиций ${sum}, а в чеке напечатан итог ${total} — не хватает ${Math.abs(diff)}.
Перечитай фотографию внимательнее. Частые причины: пропущена строка; сумма строки взята за цену за штуку (или наоборот); строка с нулевой ценой не попала в ответ; название, перенесённое на вторую строку, принято за отдельную позицию.
Верни исправленный JSON в том же формате. Если после проверки уверен, что всё верно и расхождение действительно есть в чеке, верни тот же ответ.`;

module.exports = function createGigaChat(options = {}) {
  const authKey = options.authKey || "";
  const scope = options.scope || "GIGACHAT_API_PERS";
  const model = options.model || "GigaChat-2-Pro";
  const timeout = options.timeout || 60000;

  // Сертификат Минцифры подключается переменной окружения NODE_EXTRA_CA_CERTS —
  // Node читает её при старте и добавляет корень ко всем TLS-соединениям.
  // Своего агента здесь не заводим: это потребовало бы внешней библиотеки, а в
  // проекте зависимостей нет. Отключать проверку сертификата нельзя тем более:
  // это ровно та связь, по которой уходит фотография чека.
  if (options.caFile && !process.env.NODE_EXTRA_CA_CERTS) {
    console.warn(`GigaChat: сертификат ${options.caFile} не подключён — задайте NODE_EXTRA_CA_CERTS=${options.caFile} до запуска.`);
  }

  const enabled = !!authKey;
  let token = null, tokenExpires = 0;

  async function call(url, init = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      // fetch прячет причину внутрь cause, и наружу выходит бесполезное
      // «fetch failed». Разворачиваем: без этого «не работает» невозможно
      // отличить недоверенный сертификат от отсутствия сети.
      const cause = e?.cause;
      const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
      const hint = cause?.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
          || cause?.code === "SELF_SIGNED_CERT_IN_CHAIN"
          || /unable to (get|verify)/i.test(cause?.message || "")
        ? " Похоже, не подключён корневой сертификат Минцифры — проверьте NODE_EXTRA_CA_CERTS."
        : "";
      throw new Error(`GigaChat: ${new URL(url).host} недоступен (${detail || e.message}).${hint}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Токен живёт полчаса; держим в памяти и обновляем заранее. */
  async function accessToken() {
    if (token && Date.now() < tokenExpires - 60000) return token;
    const res = await call(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + authKey,
        RqUID: crypto.randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "scope=" + encodeURIComponent(scope),
    });
    if (!res.ok) throw new Error(`GigaChat: не выдал токен (${res.status})`);
    const data = await res.json();
    token = data.access_token;
    tokenExpires = data.expires_at || (Date.now() + 25 * 60000);
    return token;
  }

  /** Загрузка файла: multipart собираем руками — зависимостей в проекте нет. */
  async function uploadImage(buffer, mime) {
    const boundary = "----trip" + crypto.randomBytes(12).toString("hex");
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\ngeneral\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.${ext}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`, "utf8");
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

    const res = await call(API_BASE + "/files", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + await accessToken(),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: Buffer.concat([head, buffer, tail]),
    });
    if (!res.ok) throw new Error(`GigaChat: не принял файл (${res.status})`);
    const data = await res.json();
    if (!data.id) throw new Error("GigaChat: ответ без идентификатора файла");
    return data.id;
  }

  /** Иногда модель оборачивает JSON в ```json — достаём объект из ответа. */
  function extractJson(text) {
    const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(raw); } catch { /* попробуем найти объект внутри */ }
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("GigaChat: ответ не похож на JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }

  /** Один заход к модели. messages передаём целиком — для второй попытки нужен диалог. */
  async function ask(messages) {
    const res = await call(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + await accessToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Ноль — чтобы одинаковое фото давало одинаковый разбор: в счётах
        // фантазия не нужна, а расхождение между двумя попытками пришлось бы
        // объяснять человеку.
        temperature: 0,
        messages,
      }),
    });
    if (!res.ok) throw new Error(`GigaChat: отказал (${res.status})`);
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || "", usage: data.usage || null };
  }

  async function readReceipt(buffer, mime) {
    if (!enabled) throw new Error("Распознавание не настроено");
    const fileId = await uploadImage(buffer, mime);
    const messages = [{ role: "user", content: PROMPT, attachments: [fileId] }];

    let first = await ask(messages);
    let bill;
    try {
      bill = extractJson(first.text);
    } catch {
      // Изредка ответ приходит битым JSON — тогда повтор помогает, в отличие
      // от случая с неверными числами.
      first = await ask(messages);
      bill = extractJson(first.text);
    }
    let usage = first.usage;

    // Не сошлось с итогом чека — даём модели её же расхождение и просим
    // перечитать. Это единственный повтор, который что-то меняет.
    const checked = checkBill(bill);
    if (!checked.matches && checked.total !== null) {
      try {
        const second = await ask([
          ...messages,
          { role: "assistant", content: first.text },
          { role: "user", content: RETRY_PROMPT(checked.sum, checked.total, checked.diff) },
        ]);
        const secondBill = extractJson(second.text);
        const retried = checkBill(secondBill);
        usage = mergeUsage(usage, second.usage);
        // Берём вторую попытку, только если она действительно ближе к итогу:
        // «исправил» в худшую сторону — не редкость, и без этой проверки
        // повтор иногда портил разбор, который уже был верным.
        if (Math.abs(retried.diff ?? Infinity) < Math.abs(checked.diff ?? Infinity)) {
          return { bill: secondBill, usage, retried: true };
        }
      } catch { /* второй заход не удался — отдаём первый разбор как есть */ }
    }
    return { bill, usage, retried: false };
  }

  const mergeUsage = (a, b) => (!a ? b : !b ? a : {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  });

  return { enabled, readReceipt, checkBill };
};

const round2 = v => Math.round(v * 100) / 100;

/**
 * Сверка разобранного чека с ним же самим. Модель ошибается не «шумом», а
 * по-крупному: теряет строку или берёт цену за штуку вместо суммы. Оба случая
 * ловятся арифметикой, потому что чек содержит собственный итог.
 *
 * Это и есть замена недостижимой точности: нам не нужно, чтобы модель никогда
 * не ошибалась, — нужно знать, когда ей верить нельзя. На двух настоящих чеках
 * разница была наглядной: у одного сумма позиций сошлась с итогом до копейки,
 * у другого не хватило 1780 рублей, и именно там пропала позиция.
 */
function checkBill(bill) {
  const items = [];
  const warnings = [];

  for (const raw of Array.isArray(bill?.items) ? bill.items : []) {
    const title = String(raw?.title ?? "").trim().slice(0, 200);
    const amount = Number(raw?.amount);
    if (!title || !Number.isFinite(amount)) { warnings.push({ kind: "skipped", title }); continue; }

    const qty = Number.isFinite(Number(raw?.qty)) ? Number(raw.qty) : null;
    const unitPrice = Number.isFinite(Number(raw?.unitPrice)) ? Number(raw.unitPrice) : null;
    const item = {
      title, amount: round2(Math.max(0, amount)), qty,
      guest: raw?.guest ? String(raw.guest).trim().slice(0, 40) : null,
    };

    // «Цена за штуку × количество» против суммы строки: ровно та ошибка, на
    // которой чек с «790.00*2 =1580.00» терял половину суммы.
    if (qty && unitPrice && Math.abs(round2(qty * unitPrice) - item.amount) > 0.01) {
      item.suspect = true;
      warnings.push({ kind: "line", title, expected: round2(qty * unitPrice), got: item.amount });
    }
    items.push(item);
  }

  const split = splitPortions(items);
  const sum = round2(split.reduce((s, i) => s + i.amount, 0));
  const total = Number.isFinite(Number(bill?.total)) ? round2(Number(bill.total)) : null;
  const diff = total === null ? null : round2(total - sum);
  if (diff !== null && Math.abs(diff) > 0.01) warnings.push({ kind: "total", total, sum, diff });

  return { items: split, sum, total, diff, matches: diff !== null && Math.abs(diff) <= 0.01, warnings };
}

/**
 * «Ньокки × 2» — это две порции, и заказать их могли двое разных людей. В чеке
 * такое пишут одной строкой, а делить нам по людям, поэтому строку разворачиваем
 * в отдельные порции.
 *
 * Позиции с известным guest не трогаем: если чек уже сказал, что это заказал
 * «Гость 1», дробить количество незачем — там нет той неопределённости, ради
 * которой порции вообще нужны. Дробить такую строку значило бы просить
 * назначить человека ещё раз тому, что и так уже отнесено к одному гостю.
 *
 * Считаем сами, а не просим модель: деление суммы на количество — ровно та
 * арифметика, которую она уже путала, а у нас она проверяемая. Разворачиваем
 * только когда сходится копейка в копейку; неделимое (три хинкали за 1000 на
 * троих не делятся ровно) оставляем одной строкой, чтобы не выдумывать копейки.
 */
function splitPortions(items) {
  const out = [];
  for (const item of items) {
    const qty = Number(item.qty);
    const each = item.guest || !Number.isFinite(qty) || qty < 2 || qty > 10 || !Number.isInteger(qty)
      ? null
      : round2(item.amount / qty);
    if (each === null || round2(each * qty) !== item.amount) { out.push(item); continue; }
    for (let i = 0; i < qty; i++) {
      out.push({ ...item, amount: each, qty: 1, portion: { index: i + 1, of: qty } });
    }
  }
  return out;
}

module.exports.checkBill = checkBill;
