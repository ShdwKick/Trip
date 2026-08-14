"use strict";
/**
 * Пошаговое обучение — подсветка настоящих элементов с карточкой рядом.
 * Сделано по образцу «Моих финансов» (там же `assets/onboarding.js`), чтобы у
 * сервисов BurningHouse обучение работало одинаково.
 *
 * Туров два, по числу больших экранов: один на списке поездок, второй внутри
 * поездки. Разделение не косметическое — внутри поездки живёт почти всё
 * содержательное (счета, расчёты, маршруты), и рассказывать про это на пустом
 * списке нечем: подсвечивать нечего.
 *
 * Каждый показывается один раз и запоминается отдельно: человек, который уже
 * освоил список, не должен снова смотреть про него, когда впервые откроет
 * поездку. Повторно оба открываются знаком вопроса в шапке — он запускает тур
 * того экрана, на котором вы сейчас.
 *
 * Отметку храним в браузере: своей таблицы настроек у сервиса нет, и заводить
 * её ради двух флагов дороже, чем показать обучение второй раз на новом
 * устройстве. В «Финансах» флаг лежит в состоянии, которое и так синхронизируется,
 * — там это досталось бесплатно, здесь нет.
 */

const TOURS = {
  list: {
    seenKey: "trip.tour.list",
    steps: [
      {
        title: "Здесь живут поездки",
        desc: "Каждая поездка — общий чек-лист на всех, кто едет. Покажем за полминуты, где что. Пропустить можно в любой момент.",
        target: null,
      },
      {
        title: "Новая поездка",
        desc: "Два коротких вопроса — название и даты, — и поездка готова. Даты можно не указывать.",
        target: "#newTripBtn",
      },
      {
        title: "Карточка поездки",
        desc: "Показывает, сколько мест отмечено, сколько человек едет и есть ли фотографии. Нажмите — откроется сама поездка.",
        target: ".trip-card",
      },
      {
        title: "Удалить поездку",
        desc: "Корзина появляется на своей поездке при наведении. Удаление уносит места, фотографии и счета у всех участников — предупредим отдельно.",
        target: ".trip-card .tc-del",
      },
      {
        title: "Это обучение",
        desc: "Знак вопроса открывает подсказки заново — для того экрана, на котором вы находитесь.",
        target: "#tourBtn",
      },
    ],
  },

  trip: {
    seenKey: "trip.tour.trip",
    steps: [
      {
        title: "Внутри поездки",
        desc: "Здесь список мест, счета и расчёты. Пройдёмся по главному.",
        target: null,
      },
      {
        title: "Смета и ваша доля",
        desc: "Сколько стоит поездка целиком и сколько приходится лично на вас. Нажмите на плитку — покажем, из каких мест это сложилось.",
        target: "#thStats",
      },
      {
        title: "Позвать попутчиков",
        desc: "Даёт ссылку-приглашение. Кто по ней войдёт — станет участником: сможет добавлять места, отмечать пункты и делить счета.",
        target: "#shareBtn",
      },
      {
        title: "Добавить место",
        desc: "Музей, отель, кафе — что угодно. Внутри места можно вставить ссылку с карты, указать время и разделить счёт.",
        target: "#newPlaceBtn",
      },
      {
        title: "Маршрут",
        desc: "Строит маршрут по точкам дня в том порядке, в котором они стоят, и открывает его в Яндекс.Картах или Google Maps.",
        target: "#routeAllBtn",
      },
      {
        title: "Место в списке",
        desc: "Галочка слева отмечает пройденное. Карандаш открывает место: там цена, кто платил, как делится счёт и позиции чека.",
        target: ".place",
      },
      {
        title: "Что взять с собой",
        desc: "Список сборов общий на всех — договорились один раз про переходник и аптечку. А галочки у каждого свои: свой рюкзак каждый собирает сам.",
        target: "#packPanel",
      },
      {
        title: "Кто кому должен",
        desc: "Когда у мест появятся цены и плательщики, здесь соберётся свод: минимум переводов вместо долга по каждому чеку.",
        target: "#debtsPanel",
      },
    ],
  },
};

let tourName = null, tourIndex = 0, tourActive = false, tourTarget = null;

/** Элемент есть в разметке, но может быть скрыт — тогда подсвечивать нечего. */
const shown = el => !!el && !!el.offsetParent && el.getBoundingClientRect().width > 0;

const tourSeen = key => {
  try { return !!localStorage.getItem(key); } catch { return true; }   // нет доступа — не навязываемся
};
const markSeen = key => {
  try { localStorage.setItem(key, "1"); } catch { /* приватный режим — переживём */ }
};

/** Показать тур экрана, если его ещё не видели. Вызывается после отрисовки. */
function maybeStartTour(name) {
  const tour = TOURS[name];
  if (!tour || tourActive || tourSeen(tour.seenKey)) return;
  // Поверх открытого диалога подсветка выглядит поломкой — подождём.
  if (document.querySelector(".scrim.open")) return;
  startTour(name);
}

function startTour(name) {
  if (!TOURS[name]) return;
  tourName = name;
  tourActive = true;
  $("onbScrim").classList.add("show");
  addEventListener("resize", repositionTour);
  addEventListener("keydown", tourKeys);
  showTourStep(0);
}

function endTour() {
  if (!tourActive) return;
  tourActive = false;
  if (tourTarget) { tourTarget.classList.remove("onb-target"); tourTarget = null; }
  $("onbScrim").classList.remove("show");
  removeEventListener("resize", repositionTour);
  removeEventListener("keydown", tourKeys);
  markSeen(TOURS[tourName].seenKey);
}

function tourKeys(e) {
  if (!tourActive) return;
  if (e.key === "Escape") endTour();
  if (e.key === "ArrowRight" || e.key === "Enter") nextTourStep();
  if (e.key === "ArrowLeft") prevTourStep();
}

function nextTourStep() {
  const steps = TOURS[tourName].steps;
  if (tourIndex < steps.length - 1) showTourStep(tourIndex + 1); else endTour();
}
function prevTourStep() { if (tourIndex > 0) showTourStep(tourIndex - 1); }

function showTourStep(i) {
  tourIndex = i;
  const steps = TOURS[tourName].steps;
  const step = steps[i];
  const target = step.target ? document.querySelector(step.target) : null;

  // Элемента нет или он скрыт — например, расчётов ещё нет, а мест не завели.
  // Такой шаг пропускаем молча: рассказ про невидимое только путает.
  if (step.target && !shown(target)) {
    return i < steps.length - 1 ? showTourStep(i + 1) : endTour();
  }
  if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
  requestAnimationFrame(() => renderTourStep(step, target, i));
}

function renderTourStep(step, target, i) {
  const steps = TOURS[tourName].steps;
  const spot = $("onbSpotlight");
  const card = $("onbCard");

  // Часть целей проявляется только при наведении (корзина на карточке поездки).
  // На время рассказа держим их видимыми — иначе подсветка обводит пустоту.
  if (tourTarget && tourTarget !== target) tourTarget.classList.remove("onb-target");
  tourTarget = target;
  if (target) target.classList.add("onb-target");
  card.innerHTML =
    `<div class="onb-dots">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>` +
    `<h3>${esc(step.title)}</h3><p>${esc(step.desc)}</p>` +
    `<div class="onb-actions">` +
      (i > 0 ? `<button class="btn text" data-tour="back">Назад</button>`
             : `<button class="btn text" data-tour="skip">Пропустить</button>`) +
      `<div class="spacer"></div>` +
      `<button class="btn filled" data-tour="next">${i < steps.length - 1 ? "Дальше" : "Готово"}</button>` +
    `</div>`;

  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.display = "block";
    spot.style.top = (r.top - pad) + "px";
    spot.style.left = (r.left - pad) + "px";
    spot.style.width = (r.width + pad * 2) + "px";
    spot.style.height = (r.height + pad * 2) + "px";
    card.classList.remove("center");
    positionTourCard(card, r);
  } else {
    spot.style.display = "none";
    card.classList.add("center");
    card.style.top = "";
    card.style.left = "";
  }
}

/** Карточка встаёт под целью, если влезает; иначе над ней; иначе по центру. */
function positionTourCard(card, rect) {
  card.style.visibility = "hidden";
  card.style.top = "0px";
  card.style.left = "0px";
  const cw = card.offsetWidth, ch = card.offsetHeight, margin = 14;
  const vw = innerWidth, vh = innerHeight;
  let top;
  if (rect.bottom + margin + ch <= vh) top = rect.bottom + margin;
  else if (rect.top - margin - ch >= 0) top = rect.top - margin - ch;
  else top = Math.max(margin, Math.min(vh - ch - margin, (vh - ch) / 2));
  const left = Math.max(margin, Math.min(vw - cw - margin, rect.left + rect.width / 2 - cw / 2));
  card.style.top = top + "px";
  card.style.left = left + "px";
  card.style.visibility = "";
}

/** Пересчёт при повороте экрана и изменении размера, пока тур открыт. */
function repositionTour() {
  if (!tourActive) return;
  const step = TOURS[tourName].steps[tourIndex];
  const target = step.target ? document.querySelector(step.target) : null;
  renderTourStep(step, target, tourIndex);
}

// Кнопки карточки живут в разметке, которую мы же и перерисовываем, поэтому
// слушаем один раз на контейнере, а не вешаем обработчики каждый раз заново.
$("onbScrim").addEventListener("click", e => {
  const action = e.target.closest("[data-tour]")?.dataset.tour;
  if (action === "next") nextTourStep();
  else if (action === "back") prevTourStep();
  else if (action === "skip") endTour();
});

/** Знак вопроса в шапке: показывает тур того экрана, где человек сейчас. */
function openTour() {
  startTour(location.hash.startsWith("#/t/") ? "trip" : "list");
}
