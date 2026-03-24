# Hindsight Bot

Telegram bot with persistent memory powered by [Hindsight](https://github.com/vectorize-io/hindsight).

## Features

- 💬 Converses via Claude (Anthropic)
- 🧠 Remembers things over time via Hindsight memory engine
- 🔍 Recalls relevant context before each response
- 📝 Saves every conversation to long-term memory

## Commands

- `/start` — greeting
- `/memory [query]` — show what the bot remembers
- `/forget` — clear current session history

## Setup

```bash
cp .env.example .env
# fill in your keys

npm install
npm run build
npm start
```

## Environment Variables

```
TELEGRAM_BOT_TOKEN=   # from BotFather
ANTHROPIC_API_KEY=    # Anthropic API key
ANTHROPIC_BASE_URL=   # optional custom base URL
HINDSIGHT_URL=        # Hindsight API URL (default: http://localhost:8888)
HINDSIGHT_BANK_ID=    # memory bank name (default: default)
```
