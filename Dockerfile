FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install -g npm@12.0.2 && npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/.env.example ./.env.example
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
