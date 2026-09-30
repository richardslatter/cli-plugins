FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY install_gh.py /app/install_gh.py
RUN python install_gh.py && /usr/local/bin/gh --version
COPY requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r requirements.lock && useradd --uid 10001 --create-home service && mkdir /var/data && chown service:service /var/data
COPY core.py security.py login.py app.py /app/
USER 10001:10001
ENV DATABASE_PATH=/var/data/github-cli.sqlite
EXPOSE 8000
CMD ["uvicorn","app:app","--host","0.0.0.0","--port","8000","--workers","1","--no-access-log"]
