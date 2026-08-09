#!/bin/sh
set -e

# Das data/-Verzeichnis ist ein Bind-Mount und gehoert beim ersten Start root.
# Der Bot laeuft aber als node (uid 1000) und muss dort schreiben koennen
# (commands.json anlegen, Panel-Aenderungen speichern). Also als root anlegen,
# dem node-User geben und erst dann per su-exec auf node wechseln.
mkdir -p /app/data
chown -R node:node /app/data

exec su-exec node "$@"
