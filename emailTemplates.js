"use strict";
/**
 * HTML/текст писем. Каркас (`shell`) — копия `Auth/lib/emailTemplates.js`,
 * не общий модуль по той же причине, что и `mailer.js`: Auth и Trip не делят
 * файловую систему в проде. Цвета и вёрстка нарочно те же, чтобы письма от
 * разных сервисов BurningHouse читались как одна семья, а не выглядели чужими
 * друг другу.
 *
 * Разметка таблицами вместо flex/grid (Outlook их не понимает), все стили
 * инлайн (многие клиенты вырезают <style>). Тёмной темы нет по той же причине,
 * что и в Auth — поддержка в почтовых клиентах ненадёжна, одна версия, которая
 * читается везде, надёжнее той, что местами ломается.
 */

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function shell({ preheader, heading, intro, buttonLabel, link, footNote }) {
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#fff6ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff6ec;">
<tr><td align="center" style="padding:32px 16px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;border:1px solid #ece5d8;">
<tr><td style="height:4px;line-height:4px;font-size:0;background:#c2410c;border-radius:20px 20px 0 0;">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 4px;">
  <div style="font-size:16px;font-weight:700;letter-spacing:-.01em;color:#1c1b20;">BurningHouse · Куда поедем?</div>
</td></tr>
<tr><td style="padding:22px 36px 0;">
  <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:600;color:#1c1b20;">${escapeHtml(heading)}</h1>
  <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#46464f;">${escapeHtml(intro)}</p>
</td></tr>
<tr><td style="padding:28px 36px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="border-radius:9999px;background:#5b4fe0;">
      <a href="${safeLink}" style="display:inline-block;padding:14px 34px;font-size:15px;font-weight:600;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:9999px;">${escapeHtml(buttonLabel)}</a>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:18px 36px 0;">
  <p style="margin:0;font-size:13px;line-height:1.5;color:#918f9a;">
    Если кнопка не открывается, скопируйте ссылку целиком:<br>
    <a href="${safeLink}" style="color:#5b4fe0;word-break:break-all;">${safeLink}</a>
  </p>
</td></tr>
<tr><td style="padding:28px 36px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #ece5d8;padding-top:18px;">
    <p style="margin:0;font-size:13px;line-height:1.5;color:#918f9a;">${escapeHtml(footNote)}</p>
  </td></tr></table>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** Напоминание собрать конкретную вещь — единственное письмо, которое отсюда уходит. */
function packingReminder({ link, tripTitle, itemTitle, whenLabel }) {
  const html = shell({
    preheader: `Поездка «${tripTitle}» — не забудьте: ${itemTitle}.`,
    heading: `Не забудьте: ${itemTitle}`,
    intro: `Вы попросили напомнить ${whenLabel} до начала поездки «${tripTitle}». Загляните в список сборов — вдруг ещё нужно что-то докупить или найти.`,
    buttonLabel: "Открыть поездку",
    link,
    footNote: "Напоминание включили вы сами в списке вещей — там же можно его выключить или перенести на другой срок.",
  });

  const text = `Не забудьте: ${itemTitle}

Вы попросили напомнить ${whenLabel} до начала поездки «${tripTitle}». Загляните в список сборов:

${link}

Напоминание включили вы сами в списке вещей — там же можно его выключить.`;

  return { subject: `Не забудьте: ${itemTitle} — ${tripTitle}`, html, text };
}

module.exports = { packingReminder };
