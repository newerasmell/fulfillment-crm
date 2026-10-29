# СТАРТ — Fulfillment CRM с Claude Code

## 1. Какво ти трябва (еднократно, ~30 мин)
- **Компютър** с Windows, Mac или Linux.
- **Node.js 22+** (nodejs.org) и **pnpm**: след като инсталираш Node, пусни `corepack enable`.
- **Docker Desktop** (docker.com) — за локална тестова база данни (Postgres).
- **Git** и **частно GitHub репо**, например `fulfillment-crm`.
- **Claude Code**: desktop приложението на Claude (раздел Code) или в терминал:
  `npm install -g @anthropic-ai/claude-code`, после `claude` и вход с акаунта ти.

## 2. Подготовка на проекта (5 мин)
```bash
# разархивирай fulfillment-crm-kit.zip, влез в папката
cd fulfillment-crm
git init -b main
git add -A
git commit -m "Starter kit"
git remote add origin https://github.com/<ТИ>/fulfillment-crm.git   # публично репо, без фирмени данни
git push -u origin main
```

## 3. Попълни решенията преди старта (10 мин)
Репото е публично, затова **истински имена, акаунти и кодове не се пишат в репото**. Те се въвеждат
в готовия CRM на Render (на GATE P0-G1). В `docs/PROGRESS.md` под **Decisions** запиши само общите правила, без имена:
- коя фирма кой акаунт във FHB и в euShipments ползва;
- маршрут по държави (пример: HR → euShipments; CZ, HU, PL, SK, SI → FHB);
- кратки кодове на магазините, по 3 букви (пример: Магазин А = AAA, Магазин Б = BBB);
- дали всички Shopify магазини са в една Shopify организация.

Липсващите неща Claude Code ще ги отбележи като въпрос и няма да гадае.

## 4. Старт — фаза 0 пред очите ти (препоръчително)
Отвори папката в Claude Code и постави точно това:

```
Прочети CLAUDE.md, docs/SPEC.md, docs/DESIGN.md, docs/BACKLOG.md и docs/PROGRESS.md.
Работи по docs/BACKLOG.md отгоре надолу, задача по задача, започвайки от P0-01,
точно по стъпките в .claude/prompts/task.md (тестове, auditor агент, commit след всяка задача).
Не ми задавай въпроси за неща, които са решени в документите. Спри при първия ред с GATE
и ми кажи какво трябва да направя аз. Ако нещо блокира задача, маркирай я [!] с причината и спри.
```

- Когато поиска разрешение за команда, избери „Allow / Don't ask again“ за `pnpm`, `git add` и `git commit`.
- След всяка задача можеш да погледнеш `docs/PROGRESS.md` и commit-а.
- Ако спре по средата или изчерпа контекста, отвори нова сесия и напиши:
  `Продължи от първата отворена задача в docs/BACKLOG.md по същите правила.`

## 5. На GATE (места, където си нужен ти)
Направи описаното в реда с GATE, смени `[ ]` на `[x]` в `docs/BACKLOG.md` и напиши
`Продължи.` (или рестартирай автопилота).

| GATE | Какво правиш ти |
|---|---|
| P0-G1 | Създаваш услугите в Render от render.yaml, env променливите и първия собственик (OWNER) |
| P1-G1 | Shopify Dev Dashboard приложение, инсталация в магазините, ключове в CRM |
| P2-G1 | FHB и Joy ключове от ZOE (връзката остава само за четене), `pnpm fixtures:record` |
| P3-G1 | euShipments токен; потвърждение от тях за `testMode` в продукция |
| P4-G1 | Преглед на пробните изпращания → режим канарче → на живо |
| P8-G1 | Anthropic API ключ за AI асистента в приложението |

## 6. Без теб на бюрото (автопилот)
След фаза 0 следвай `docs/AUTONOMY.md`: сървър с Docker, попълнен `autopilot/autopilot.env`, после
`docker compose -f autopilot/docker-compose.yml up -d --build`.
Работи сам, пише ти в Telegram и спира само на GATE, при блокиране или при изчерпан бюджет.

## 7. Правила за безопасност (важно)
- В средата, в която Claude Code строи, **никога** не слагай продукционни ключове за FHB, euShipments или Shopify. Те се въвеждат само в готовия CRM на Render.
- Сливането в `main` е ръчно: преглеждаш PR на фазата и го одобряваш.
- Всяка връзка към склад започва в режим „Четене“. Само ти я местиш нагоре.
