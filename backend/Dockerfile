# debian-slim (pas alpine) : better-sqlite3 a besoin d'un binaire prébuilt compatible
# glibc, évite d'avoir à installer une chaîne de compilation dans l'image.
FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./

ENV NODE_ENV=production
VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "server.mjs"]
