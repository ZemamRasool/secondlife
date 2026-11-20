# ---- build stage: install everything, generate the Prisma client, compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
# prisma generate does not connect to the database; a placeholder URL is enough
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
COPY src ./src
RUN npm run build

# ---- run stage: only what production needs ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save prisma@7.10.1
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=build /app/dist ./dist
COPY public ./public
# Run as the unprivileged 'node' user, not root
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 3000
# Apply database migrations, then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
