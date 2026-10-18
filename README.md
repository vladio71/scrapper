# ua-jobs-watcher

Scrapes Node.js / Full-Stack / AI vacancies from jobs.dou.ua and djinni.co, scores each one against my stack, and sends the good ones to Telegram.

## How it works

- `scrape-jobs.ts` pulls listings (DOU category pages and RSS, Djinni keyword pages), fetches details, detects stack signals (languages, LLM tooling, frontend), deduplicates cross-posted vacancies by a description fingerprint and writes `vacancies.json`.
- `watch-filter.ts` classifies a vacancy as backend / fullstack / frontend / llm-pure / other and scores it with the weights from `watch.config.json` (title, stack signals, free text, foreign-stack penalty, salary and age thresholds).
- `watch.ts` runs the scraper on a cron cycle, backs off a host after 429/503, sends instant Telegram messages for backend/fullstack/frontend matches and a daily digest for llm-pure ones, and remembers what was already sent.

Everything that decides what I get notified about lives in `watch.config.json`, no code change needed to retune it.

## Run

```bash
npm install
cp .env.example .env   # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional DJINNI_COOKIE
npm run scrape         # one-off: vacancies.json
npm run watch:dry      # classify + score, send nothing
npm run watch:test     # one cycle, example messages to Telegram
npm run watch          # long-running watcher
npm test
```

Node 20+. `update-task.ps1` registers the watcher as a Windows Task Scheduler job that runs detached from the desktop.
