"use strict";
/**
 * Отправка почты через Resend — копия `Auth/lib/mailer.js`, не общий модуль:
 * Auth и Trip разворачиваются раздельными контейнерами и файловой системы не
 * делят, так что делить код тут не из чего. Обычный HTTP API, встроенного
 * fetch() достаточно, SMTP-клиент не нужен — так и остаёмся без npm-зависимостей.
 *
 * Без RESEND_API_KEY письма не уходят, а текст падает в консоль — иначе
 * локальная разработка и e2e-тесты без живого аккаунта Resend были бы
 * невозможны.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "BurningHouse <noreply@burninghouse.ru>";

async function send({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log(`[mailer] RESEND_API_KEY не задан — письмо не отправлено. Кому: ${to}, тема: «${subject}»\n${text || ""}`);
    return { ok: false };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }),
    });
    if (!res.ok) {
      console.error(`[mailer] Resend ответил ${res.status}: ${await res.text().catch(() => "")}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error("[mailer] Не удалось отправить письмо:", e.message);
    return { ok: false };
  }
}

module.exports = { send };
