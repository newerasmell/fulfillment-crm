# UI design direction

We do **not** copy or scrape the vendor panels (ZOE, euShipments cabinet). We build one unified interface
for both warehouses, using the **vocabulary and grouping the team already knows** from those panels.
Screenshots of the vendor panels go in `docs/reference-screens/` **locally only** (they show real stock and
COD data, so `*.png` there is git-ignored and never committed) and work as a **coverage checklist**: every field or action
visible there must exist somewhere in the CRM, or be listed under "stays in the vendor panel" below.

Concept canvas (6 screens, clickable): the "Fulfillment CRM — дизайн концепция" artifact in Claude.
It is the visual reference for P0-11 and every UI task.

## Principles
1. **Familiar words, one place.** Menu groups follow euShipments (Работа / Склад / Пари / Справки /
   Настройки); names follow both panels (Товарителници, Приемане на стока, Наложен платеж, RMA → Връщания).
2. **Exceptions first.** Начало starts with "Изисква внимание" (за преглед, блокирани, с грешки, върнати за
   възстановяване, тикети, изчерпване). Every number links to the filtered list.
3. **Warehouse scope everywhere.** A segmented control in the header: Всички складове / FHB / euShipments.
   It filters every screen. Warehouse identity colours are used the same way everywhere (chips, chart
   series, dots), always with the name next to the colour.
4. **Show what will be sent.** Order detail shows the routing rule and the exact vendor payload.
5. **Original vs corrected.** Automatic corrections show the original crossed out; the original is kept.
6. **Keyboard first.** Ctrl/Cmd K search (order, AWB, customer, phone, SKU, EAN); J/K; A/H/R; "+ Създай"
   menu in the header (like ZOE "Create"): manual shipment, stock receipt, product.
7. **Every decision teaches the AI** (reason codes, "Не е вярно — защо?").
8. **Safety and freshness visible.** Mode per connection in the sidebar footer and on Складове; every stock
   number shows source and age (FHB push vs euShipments snapshot).
9. **Original names as hints.** In the warehouse mirror, each tab shows our Bulgarian name and the vendor's
   original name under it (e.g. "Приемане на стока / Stock receipts").

## Navigation (sidebar)
- Фирма (account switcher) on top.
- **Начало**
- **Работа:** Поръчки (badge: за преглед) · Товарителници (incl. tracking) · Връщания · Тикети от склада
- **Склад:** Продукти и наличности · Приемане на стока · Ръчни пратки и етикети
- **Пари:** Наложен платеж · Фактури · Справки
- **Настройки:** Складове и връзки · Магазини · Правила за маршрут · AI асистент · Офиси, PUDO, потребители
- Footer card: "Режим на складовете" (FHB · На живо, euShipments · Канарче 6/10) → Складове.
Header: search · warehouse scope · "+ Създай" · notifications · profile/language.

## Mapping from the vendor panels
| CRM | ZOE (FHB) | euShipments |
|---|---|---|
| Начало | — | Дашборд |
| Поръчки | Orders | Импорт → Поръчки/Товарителници |
| Товарителници | Shipments, Tracking | Статистика → Товарителници |
| Връщания | Return | RMA |
| Тикети от склада | Tickets | — |
| Продукти и наличности | Stock (+Archive, History) | Фулфилмънт → Продукти |
| Приемане на стока | Stock receipts | Фулфилмънт → Приемане на стока |
| Ръчни пратки и етикети | Create → shipment (Joy) | Товарителници (createAWB) |
| Наложен платеж | COD | Статистика → Наложен платеж |
| Фактури | — | Статистика → Списък с фактури |
| Справки | Stats | Статистика |
| Складове и връзки | API, Settings | Настройки → Ecommerce интеграции |
| Магазини | — | Интеграции → Електронни магазини |
| Офиси, PUDO, потребители | — | Информация → PUDO локации, Адресна книга, Клиентски данни |

**Stays in the vendor panel (no API for it — show a "в ZOE ↗" / "в euShipments ↗" link):**
ZOE batches and expiry dates, Extra material, Marketing, ticket text/replies (FHB API only sends ticket
event notifications); euShipments expiring products, news, work schedule.
**Unclear, ask the team:** euShipments "Дневни операции"; which Stats/Статистика reports are used weekly.

## Key screens (see the canvas)
1. **Начало** — attention cards; today KPIs (orders, items sold, AWBs, countries, couriers, with
   yesterday comparison and FHB/euShipments split); stacked bar chart of AWBs for 30 days per warehouse
   with hover readout; COD by currency (чака от куриера / получен / изплатен); per-country bars
   coloured by warehouse; recent events.
2. **Поръчки** — tabs with counts (За преглед, Готови, Блокирани, В транзит, Всички), filter chips,
   import from file, CSV/XLS export, table with warehouse chip + courier, checks chip, AI suggestion,
   sticky dark bulk bar.
3. **Поръчка** — customer & address with corrections, items with stock per warehouse, AI card,
   pre-flight checks, routing + payload preview, timeline, sticky decision bar.
4. **Продукти и наличности** — modelled on ZOE Stock: tabs (Наличности, Движения, Комплекти, Архив,
   Известия, Партиди и срокове ↗), search by name/SKU/RTM…/RSK…/EAN, quick filters with counts
   (Всички, С наличност, Нулева, Тестери, Свършват до 7 дни, Разминаване със Shopify),
   "Тестерите под оригинала" grouping, columns: product + TESTER badge, our SKU + EAN
   ("EAN = код в склада" or real EAN with "реален, от FHB" when the warehouse corrected it), FHB internal
   (RTM…) and external (RSK…) code, FHB physical/free, euShipments, Shopify, state; pagination 50/page.
   Right panel: codes, EAN history, stock per warehouse, last movements, actions.
5. **Складове и връзки** — connection cards (account: ZOE client id, euShipments company — real values come from the connection record; mode stepper;
   today numbers; freshness; "Отвори ZOE ↗"), emergency stop, mirror section with FHB/euShipments switch
   whose tabs follow each vendor's own menu with the original names under them, alerts feed.
6. **Карта на менюто** — the mapping table above, for onboarding the team.

## Tokens
| Token | Value | Use |
|---|---|---|
| bg | #F6F6F3 | app background |
| surface | #FFFFFF | cards, tables |
| line | #E4E4DF / #EFEFEA | borders / row dividers |
| ink | #17171A | text |
| muted | #5E5E66 (labels #6B6B73) | secondary text |
| accent | #2747C9, soft #E8ECFB, strong #1A3399 | primary actions, active nav/tab, links |
| FHB | #5B3CC4, chip #EFEAFB / text #4A2FA8 | warehouse identity |
| euShipments | #1F9A96, chip #E2F3F2 / text #136B68 | warehouse identity |
| ok | #1F6F43 on #E7F4EC | passed checks |
| warn | #9A4508 on #FDF1E6 | warnings, auto-corrections |
| block | #A51C12 on #FDECEA | blocking problems, destructive actions |
| dark panel | #17171A | AI card, bulk-action bar |
FHB/euShipments chart pair validated for colour-blind separation (ΔE ≥ 18 deutan/tritan) and ≥3:1
contrast on white. Status colours are never reused for warehouses. Radius 10–14px cards, 999px pills.
Fonts: Inter (UI), JetBrains Mono (ids, codes, numbers). Status is never colour-only. Targets ≥ 40–44px.

UI language: Bulgarian default, English available; vendor status names shown as received
(e.g. "Information received") next to our Bulgarian status.
