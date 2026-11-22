FROM node:22.23.1-slim

WORKDIR /app
# The lockfile pins every dependency; `npm ci` installs exactly it, so a deploy runs what was reviewed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs .

EXPOSE 8080
CMD ["node", "server.mjs"]
