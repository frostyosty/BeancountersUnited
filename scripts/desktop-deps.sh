#!/usr/bin/env bash
# Installs what the desktop apps (Tauri 2) need to compile on Ubuntu: WebKitGTK and friends.
# Windows builds need nothing extra; they use WebView2.
set -euo pipefail
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev \
  librsvg2-dev libayatana-appindicator3-dev libxdo-dev
sudo apt-get clean
