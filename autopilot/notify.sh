#!/usr/bin/env bash
# Sends a message to Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) and/or a Slack-style webhook (NOTIFY_WEBHOOK_URL).
msg="$1"
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  curl -fsS -m 20 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null || true
fi
if [ -n "${NOTIFY_WEBHOOK_URL:-}" ]; then
  curl -fsS -m 20 -H 'Content-Type: application/json' -d "$(jq -n --arg t "$msg" '{text:$t}')" "$NOTIFY_WEBHOOK_URL" >/dev/null || true
fi
