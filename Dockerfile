FROM python:3.12-slim

WORKDIR /srv
ENV PYTHONUNBUFFERED=1 STOCK_DB_PATH=/data/stock.db

RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

VOLUME ["/data"]
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8100/healthz || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
