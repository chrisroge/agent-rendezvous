# ---- build stage ----
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM docker.io/library/node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# RDS CA bundle so the app can verify the database's TLS certificate.
RUN wget -q -O /app/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY protocol ./protocol
COPY docs ./docs
COPY web ./web
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
