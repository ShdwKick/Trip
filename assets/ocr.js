"use strict";
/**
 * Распознавание чека по фотографии.
 *
 *   await ocrReceipt(file, onProgress) → текст
 *
 * Всё локально: движок и русская модель лежат в assets/vendor и загружаются с
 * нашего же домена. Фотография чека никуда не уходит — это единственное место,
 * где в сервис попадает изображение с суммами, и отдавать его постороннему
 * сервису ради удобства не стоит.
 *
 * Порядок такой: сначала картинку приводят в вид, который Tesseract умеет
 * читать, и только потом запускают распознавание. Без подготовки на фотографии
 * термочека — неровный свет, серый фон, тени от пальцев — движок выдаёт кашу;
 * с ней получается текст, пригодный для разбора.
 *
 * Подготовка нарочно сделана на обычном canvas, без OpenCV: из десяти мегабайт
 * вассемблера здесь понадобилось бы полпроцента, а нужное — обесцветить,
 * растянуть контраст и взять локальный порог — это сотня строк.
 */

(function (root) {
  const VENDOR = "assets/vendor/";
  const LANG = "rus";           // русская модель читает и латиницу; отдельный eng — ещё 3 МБ
  const MAX_SIDE = 1600;        // выше этого точность не растёт, а время и память растут

  /**
   * Есть ли в браузере SIMD. Мы закрепили одну сборку ядра (см. vendor/README),
   * поэтому проверяем сами: честное «не получится» лучше, чем непонятная ошибка
   * из глубины воркера.
   */
  function hasSimd() {
    try {
      // Минимальный модуль с инструкцией v128 — валидатор его примет, только
      // если SIMD поддерживается.
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]));
    } catch { return false; }
  }

  let loading = null;
  /** Движок подгружаем по требованию: 6,6 МБ не должны висеть на каждой странице. */
  function loadEngine() {
    if (root.Tesseract) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VENDOR + "tesseract.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("не удалось загрузить движок распознавания"));
      document.head.append(s);
    });
    return loading;
  }

  /** Файл → canvas, уменьшенный до разумного размера. */
  async function toCanvas(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas;
  }

  /**
   * Обесцвечивание. Растягивать контраст глобально здесь нельзя, и это стоило
   * мне одного пустого распознавания: текста на чеке меньше двух процентов
   * площади, и любой отброс «выбросов» по процентилям выкидывает ровно его,
   * оставляя чистый фон. Контраст вытягивает локальный порог ниже.
   */
  function toGray(imageData) {
    const { data, width, height } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Веса — стандартные для яркости: глаз видит зелёный сильнее синего.
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    return gray;
  }

  /**
   * Локальный порог (метод Брэдли): пиксель становится буквой, если он темнее
   * среднего по окну на заданную ДОЛЮ, а не на фиксированное число. Доля важна:
   * на свежем чеке текст почти чёрный, на выцветшем — светло-серый, и
   * абсолютный порог годится ровно для одного из этих случаев.
   *
   * Среднее по окну берём через интегральное изображение — иначе на каждый
   * пиксель приходился бы обход всего окна.
   */
  function adaptiveThreshold(gray, width, height) {
    const win = Math.max(15, (Math.min(width, height) / 12) | 0) | 1;   // нечётное
    const half = win >> 1;
    const k = 0.15;   // насколько доля темнее среднего считается буквой

    const integral = new Float64Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += gray[y * width + x];
        integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
      }
    }
    const out = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(height - 1, y + half);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(width - 1, x + half);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * (width + 1) + (x1 + 1)]
          - integral[y0 * (width + 1) + (x1 + 1)]
          - integral[(y1 + 1) * (width + 1) + x0]
          + integral[y0 * (width + 1) + x0];
        out[y * width + x] = gray[y * width + x] * area < sum * (1 - k) ? 0 : 255;
      }
    }
    return out;
  }

  /** Подготовленная картинка: чёрный текст на белом, как в учебнике. */
  async function prepare(file) {
    const canvas = await toCanvas(file);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const gray = toGray(image);
    const bw = adaptiveThreshold(gray, canvas.width, canvas.height);
    for (let p = 0, i = 0; p < bw.length; p++, i += 4) {
      image.data[i] = image.data[i + 1] = image.data[i + 2] = bw[p];
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /**
   * Распознать чек. onProgress получает 0…1 — распознавание на телефоне идёт
   * секунды, и молчащая кнопка выглядит зависшей.
   */
  async function ocrReceipt(file, onProgress = () => {}) {
    if (!hasSimd()) throw new Error("Браузер слишком старый для распознавания — вставьте текст чека вручную");
    onProgress(0.02);
    const canvas = await prepare(file);
    onProgress(0.1);
    await loadEngine();

    const worker = await root.Tesseract.createWorker(LANG, 1, {
      workerPath: VENDOR + "worker.min.js",
      corePath: VENDOR + "tesseract-core-simd-lstm.wasm.js",
      langPath: VENDOR,
      // Прогресс движка занимает большую часть ожидания, отсюда и смещение.
      logger: m => { if (m.status === "recognizing text") onProgress(0.15 + m.progress * 0.85); },
    });
    try {
      // 6 — «один сплошной блок текста». Чек так и устроен, а вот режимы с
      // разбором вёрстки видят в нём две колонки и разносят названия и суммы
      // по разным блокам, разрывая строки.
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      // Просим координаты слов: без них не отличить колонку количества от
      // разряда тысяч — см. columnsToText.
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      onProgress(1);
      return columnsToText(data) || data.text || "";
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Собирает строки из слов, помечая табуляцией широкие пробелы — границы
   * колонок. Это единственный способ развести две одинаковые с виду строки:
   *
   *     Завтрак Папа может      1     790.00     → количество и сумма
   *     Итого к оплате Гость 1:     1 280.00     → одно число с разрядами
   *
   * Расстояние между «1» и «790.00» в первой строке — ширина колонки, между
   * «1» и «280.00» во второй — обычный пробел. По тексту это неразличимо, по
   * координатам — очевидно.
   */
  function columnsToText(data) {
    // Все слова разом, без деления на блоки. Собственная разметка Tesseract
    // здесь мешает: колонку с названиями и колонку с суммами он считает
    // разными блоками текста и выдаёт их подряд — сначала все названия, потом
    // все числа. Строка чека при этом рассыпается, и связь «что сколько стоит»
    // теряется ещё до разбора. Поэтому строки собираем сами, по координатам.
    const words = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            if ((w.text || "").trim() && w.bbox) words.push(w);
          }
        }
      }
    }
    if (!words.length) return "";

    // Группируем в строки по вертикальному перекрытию: слова одной строки
    // перекрываются по высоте, даже если Tesseract развёл их по разным блокам.
    const heights = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const lineHeight = heights[heights.length >> 1] || 12;
    const rows = [];
    for (const w of [...words].sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2)) {
      const mid = (w.bbox.y0 + w.bbox.y1) / 2;
      const row = rows[rows.length - 1];
      if (row && Math.abs(mid - row.mid) <= lineHeight * 0.6) {
        row.words.push(w);
        row.mid = (row.mid * (row.words.length - 1) + mid) / row.words.length;
      } else {
        rows.push({ mid, words: [w] });
      }
    }

    return rows.map(row => {
      const words = row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!words.length) return "";

      // Ширину знака берём медианой по строке: средняя уезжает от одного
      // длинного слова, а нам нужен масштаб «обычного пробела».
      const widths = words.map(w => (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.trim().length)).sort((a, b) => a - b);
      const charWidth = widths[widths.length >> 1] || 8;

      let out = words[0].text.trim();
      for (let i = 1; i < words.length; i++) {
        const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
        // Порог подобран с запасом: обычный пробел — примерно один знак,
        // колонка — заметно больше. Полтора знака разделяет их надёжно и не
        // рвёт строку на словах, набранных вразрядку.
        out += (gap > charWidth * 1.5 ? "\t" : " ") + words[i].text.trim();
      }
      return out;
    }).join("\n");
  }

  root.ocrReceipt = ocrReceipt;
  root.ocrSupported = hasSimd;
  root.ocrPrepare = prepare;   // для отладки: посмотреть, что уходит в движок
})(typeof window !== "undefined" ? window : globalThis);
