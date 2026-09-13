FROM node:24.20.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node . /app
USER node
WORKDIR /app
CMD ["npm", "run", "check"]
