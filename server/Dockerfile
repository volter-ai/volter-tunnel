FROM node:22-slim

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.mjs .

EXPOSE 8080
CMD ["node", "server.mjs"]
