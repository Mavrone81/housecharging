FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
# Drop root: the node:alpine image ships an unprivileged `node` user (uid 1000).
# The app only reads its (world-readable) files and talks to Postgres — it never
# writes to the container filesystem — so running as non-root is safe (VAPT M-2).
USER node
CMD ["node", "src/server.js"]
