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
      // Чек — это столбец строк, а не абзац: разбивать его на колонки не нужно,
      // иначе цены уезжают в отдельный блок и теряют связь с названиями.
      await worker.setParameters({ tessedit_pageseg_mode: "4" });
      const { data } = await worker.recognize(canvas);
      onProgress(1);
      return data.text || "";
    } finally {
      await worker.terminate();
    }
  }

  root.ocrReceipt = ocrReceipt;
  root.ocrSupported = hasSimd;
  root.ocrPrepare = prepare;   // для отладки: посмотреть, что уходит в движок
})(typeof window !== "undefined" ? window : globalThis);
