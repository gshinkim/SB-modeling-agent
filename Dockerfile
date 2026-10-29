# Tellurium needs a compiled C++ solver (libroadrunner), so this has to be a
# container - it will not fit a serverless function.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# solver layer first: it is big and changes rarely
COPY requirements.txt .
RUN python -m venv /app/.venv \
 && /app/.venv/bin/pip install --no-cache-dir -U pip \
 && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt \
 && /app/.venv/bin/python -c "import tellurium; print('tellurium', tellurium.__version__)"

COPY backend ./backend
COPY web ./web
COPY agents ./agents
COPY skills ./skills

RUN mkdir -p workspace/runs
ENV PORT=8080 HOST=0.0.0.0 MCA_HOSTED=1
EXPOSE 8080
CMD ["node", "backend/server.mjs"]
