FROM node:22-alpine

# su-exec: erlaubt dem Entrypoint, nach dem chown von root auf node zu wechseln.
RUN apk add --no-cache su-exec

WORKDIR /app

# Erst nur die Manifeste kopieren -> Layer-Cache bleibt bei Code-Änderungen erhalten
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# commands.json kommt als Fallback mit ins Image: beim ersten Start wird sie
# nach data/ (Volume) kopiert, danach ist nur noch die Kopie relevant.
COPY index.js admin.js store.js settings.js emoji.js twitch.js commands.json ./
COPY public ./public
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Kein "USER node" hier: der Entrypoint startet als root, korrigiert die
# Rechte des gemounteten data/-Verzeichnisses und wechselt dann selbst per
# su-exec auf den unprivilegierten node-User.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
