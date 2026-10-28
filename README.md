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
cp .env.example .env   # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional DJINNI_COOKIE, APP_URL + APP_TOKEN
npm run scrape         # one-off: vacancies.json
npm run watch:dry      # classify + score, send nothing
npm run watch:test     # one cycle, example messages to Telegram
npm run watch          # long-running watcher
npm run stack-stats    # which technologies backend + fullstack vacancies ask for
npm test
```

Node 20+. `update-task.ps1` registers the watcher as a Windows Task Scheduler job that runs detached from the desktop.

## Черга заявок, дайджест і статистика стеку

**Черга заявок у study app.** Кожна вакансія, яка проходить поріг backend / fullstack / frontend і йде в Telegram, також відправляється `POST {APP_URL}/api/applications` із заголовком `x-automation-token` і тілом `{url, title, company, source, score, description}` (`watch-app.ts`). Невдалий запит лише пишеться в `.watch/watch.log`, Telegram працює як раніше. Тимчасові помилки (мережа, 404 поки ендпоінт не задеплоєний, 5xx) повторюються на початку наступного циклу: до 50 вакансій, до 7 днів, список лежить у `.watch/state.json` (`appQueuePending`). 400 / 401 / 403 не повторюються. Вимкнути: `"appQueueEnabled": false` у `watch.config.json`.

**Дайджест готових заявок.** Раз на день (`appDigestCron`, за замовчуванням `0 20 * * *`, локальний час машини, як і `digestCron`) watcher читає `GET {APP_URL}/api/applications?status=ready&brief=1` і шле одне повідомлення «У черзі N готових заявок»: до 10 рядків «назва, компанія» і посилання на `{APP_URL}/applications`. Якщо запит не вдався або N = 0, нічого не шле. Порожній рядок у `appDigestCron` вимикає дайджест. `npm run watch:test` теж пробує цей дайджест (тільки читання, у чергу нічого не пише).

**Налаштування.** `APP_URL` і `APP_TOKEN` у `.env` (той самий рядок, що `AUTOMATION_TOKEN` в апці). Без них обидві функції вимкнені, у лог пишеться один рядок при старті.

**Статистика стеку.** `npm run stack-stats` читає `vacancies.json` (результат `npm run scrape`; watcher зберігає лише сирий HTML у `.cache/`, тому іншого джерела немає), бере backend + fullstack за останні 60 днів (той самий `categorize()`, що й у watcher) і друкує таблицю технологія / кількість / відсоток вакансій, відсортовану за відсотком, плюс кількість проаналізованих вакансій, діапазон дат публікації і скільки відкинуто (дублікати, зняті, інші категорії, старші за вікно, без дати). Технології та синоніми в `stack-stats.config.json`: збіг цілим словом без урахування регістру, для слів, які є і звичайними англійськими (`Express`, `React`, `RAG`, `Jest`), окремий список із точним регістром.

```bash
npm run stack-stats                     # vacancies.json, 60 днів
npm run stack-stats -- --days=30
npm run stack-stats -- --json
npm run stack-stats -- --input=test-data/vacancies.sample.json   # приклад на тестових даних
```
