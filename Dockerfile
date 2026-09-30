FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
# settingsController.ts creates both of these at startup (uploads/business
# for logos, and backups — a sibling of uploads, not inside it) — both have
# to exist AND be owned by the 'node' user before CMD runs, since the
# process drops root via USER node below and /app itself stays root-owned.
# uploads/ is usually fine at runtime because Railway's persistent volume
# gets mounted over it with its own (writable) permissions, but backups/
# has no such mount — without this, mkdir('backups') hits EACCES and
# crashes the process before the server ever starts listening.
RUN mkdir -p uploads backups && chown -R node:node uploads backups
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
USER node
CMD ["node", "dist/server.js"]