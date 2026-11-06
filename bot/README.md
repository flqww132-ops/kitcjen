# Бот-напоминальщик «Книги кухни»

Маленький сервер на Cloudflare Workers (бесплатный тариф). Приложение отдаёт ему расписание
напоминаний о заготовках и таймеров, а он в нужную секунду пишет в чат Telegram.

## Подключение (один раз)

1. Ключ бота: в @BotFather → `/mybots` → бот → **API Token** → скопировать.
2. https://dash.cloudflare.com → зарегистрироваться (почта, пароль, подтвердить почту).
3. **Workers & Pages** → **Create application** → **GitHub** → разрешить доступ к репозиторию `kitcjen` → выбрать его.
4. Настройка проекта:
   - **Project name**: `kniga-kuhni-bot` (должно совпадать с `name` в `bot/wrangler.toml`);
   - **Root directory** (в дополнительных настройках сборки): `bot`;
   - **Build command** — пусто, **Deploy command** — `npx wrangler deploy` (по умолчанию).
   → **Save and Deploy**.
5. Открыть Worker → **Settings** → **Variables & Secrets** → **Add** → тип **Secret**,
   имя `BOT_TOKEN`, значение — ключ бота → **Deploy** / **Save**.
6. Скопировать адрес Worker (вида `https://kniga-kuhni-bot.ИМЯ.workers.dev`) и вставить в приложении:
   **Настройки → Напоминания в Telegram → Адрес бота** → **Сохранить и проверить**. В чат придёт тестовое сообщение.

Необязательно: секрет `ALLOWED_USERS` — id пользователей Telegram через запятую, кому разрешено
пользоваться ботом.

## Как устроено

- `PUT /api/reminders` — приложение присылает полный список будущих сообщений `{ items: [{ at, text, key }] }`.
- `GET /api/status`, `POST /api/test` — состояние и тестовое сообщение.
- Каждый запрос подписан данными Telegram (`X-Init-Data`), бот проверяет подпись своим ключом.
- У каждого пользователя свой Durable Object с будильником (alarm) — точность до секунды.
