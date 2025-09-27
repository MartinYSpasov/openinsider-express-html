FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY arima_fourier_ta_strategy.py /app/
COPY model_service.py /app/

# Non-root + cache dir for fetched price data
RUN useradd -m appuser && chown -R appuser /app
USER appuser

EXPOSE 8000
CMD ["python","-m","uvicorn","model_service:app","--host","0.0.0.0","--port","8000","--workers","2"]
