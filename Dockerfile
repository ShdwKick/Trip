FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме.
# Зависимостей нет вовсе: SQLite — встроенный node:sqlite, проверка токенов —
# auth-client.js на 200 строк. Поэтому ни npm install, ни node_modules здесь нет.
#
# Модули берём маской, а не по одному: перечисление уже подводило — новый
# gigachat.js забыли вписать, и контейнер падал в цикле с MODULE_NOT_FOUND.
# Маска захватывает server.js, auth-client.js, gigachat.js и всё, что появится
# дальше. Локальный запускатор dev.mjs сюда не попадает — он .mjs.
COPY *.js ./
COPY index.html ./
COPY assets/ ./assets/

# Проверка на этапе сборки: пропавший модуль ломает сборку, а не контейнер на
# сервере. Запускать сервер нельзя — он бы занял порт и повис, поэтому только
# наличие файлов и разбор синтаксиса.
RUN set -e; \
    for f in server.js auth-client.js admin-internal.js gigachat.js mailer.js emailTemplates.js index.html; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    for f in server.js auth-client.js admin-internal.js gigachat.js mailer.js emailTemplates.js; do node --check "$f"; done

# Каталог данных: store.db и фотографии. В контейнере он смонтирован томом —
# см. docker-compose.yml.
RUN mkdir -p /app/data/photos && chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=8790
ENV DATA_DIR=/app/data

EXPOSE 8790
VOLUME ["/app/data"]

CMD ["node", "server.js"]
