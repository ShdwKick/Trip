FROM node:24-alpine

WORKDIR /app

# Копируем только то, что реально нужно в рантайме.
# Зависимостей нет вовсе: SQLite — встроенный node:sqlite, проверка токенов —
# auth-client.js на 200 строк. Поэтому ни npm install, ни node_modules здесь нет.
COPY server.js ./
COPY auth-client.js ./
COPY index.html ./
COPY assets/ ./assets/

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
