FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
# Give the unprivileged runtime user ownership so it can read every app file
# regardless of the source file modes (e.g. a 600 public/index.html on the host).
RUN chown -R node:node /app
ENV NODE_ENV=production
EXPOSE 3000
# Drop root: the node:alpine image ships an unprivileged `node` user (uid 1000).
# The app only reads its files and talks to Postgres — it never writes to the
# container filesystem — so running as non-root is safe (VAPT M-2).
USER node
CMD ["node", "src/server.js"]
