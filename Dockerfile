FROM python:3.12-slim

WORKDIR /srv
ENV PYTHONUNBUFFERED=1 STOCK_DB_PATH=/data/stock.db

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

VOLUME ["/data"]
EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
