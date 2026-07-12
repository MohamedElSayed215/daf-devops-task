# =============================================================================
# Stage 1 - Install Production Dependencies
# =============================================================================
FROM node:20.19.4-alpine AS deps

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev \
    && npm cache clean --force


# =============================================================================
# Stage 2 - Runtime
# =============================================================================
FROM node:20.19.4-alpine

LABEL org.opencontainers.image.title="orders-api" \
      org.opencontainers.image.description="Shop Backend Orders API" \
      org.opencontainers.image.version="0.1.0"

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup \
 && adduser -S appuser -G appgroup

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy application source only
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup package.json ./

# Runtime environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as non-root
USER appuser

CMD ["node", "src/index.js"]
