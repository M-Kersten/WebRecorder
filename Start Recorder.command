#!/usr/bin/env bash
# Double-click this file to open the Walkthrough Recorder.
# Nothing here needs a terminal; this just starts the app.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed on this machine."
  echo "  Install it from https://nodejs.org (take the LTS version),"
  echo "  then double-click this file again."
  echo
  read -r -p "  Press Enter to close." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run: installing what the recorder needs. This takes a minute."
  npm install --no-audit --no-fund || {
    echo
    echo "  That did not work. Send this window to whoever set the tool up."
    read -r -p "  Press Enter to close." _
    exit 1
  }
fi

node src/index.js ui
