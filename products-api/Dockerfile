# =============================================================================
# Stage 1 - Build Dependencies
# =============================================================================
FROM python:3.12.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .

RUN pip install --prefix=/install -r requirements.txt


# =============================================================================
# Stage 2 - Runtime
# =============================================================================
FROM python:3.12.11-slim

LABEL org.opencontainers.image.title="products-api" \
      org.opencontainers.image.description="Shop Backend Products API" \
      org.opencontainers.image.version="0.1.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Create non-root user
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --create-home --shell /usr/sbin/nologin appuser

# Copy installed dependencies
COPY --from=builder /install /usr/local

# Copy application only
COPY --chown=appuser:appgroup app ./app

EXPOSE 8000

USER appuser

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
