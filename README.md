# Бот-магазин на Cloudflare: запуск через GitHub

Бот работает в облаке Cloudflare (бесплатный тариф), код берёт с GitHub.
Свои устройства и сервер не нужны. Всё делается в браузере.

## Что понадобится
- аккаунт на [github.com](https://github.com);
- аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com);
- бот в Telegram: у @BotFather команда `/newbot`, сохраните токен.

Названия пунктов меню в Cloudflare иногда меняются, ищите похожие по смыслу.

## Шаг 1. База данных (Cloudflare)
1. В панели Cloudflare: **Storage & databases → D1 SQL Database → Create**.
2. Имя: `shop-bot-db`. Создайте.
3. Скопируйте **Database ID** (длинный код из букв и цифр).

## Шаг 2. Код на GitHub
1. На GitHub: **New repository**, имя `shop-bot`, можно Private.
2. Папок в проекте нет, все файлы лежат рядом: `index.js`, `wrangler.jsonc`,
   `package.json`, `README.md`. Распакуйте архив и загрузите их все сразу:
   **Add file → Upload files**, выберите все файлы (с телефона и компьютера работает
   одинаково), затем **Commit changes**. Файл `.gitignore` не обязателен.
3. Откройте на GitHub `wrangler.jsonc` (карандаш ✏️) и впишите:
   - `database_id` — код из шага 1;
   - `SHOP_NAME`, `MANAGER_USERNAME` (без @), при желании `CURRENCY`.

   Нажмите **Commit changes**.

## Шаг 3. Подключить GitHub к Cloudflare
1. **Workers & Pages → Create → Import a repository** (подключение к GitHub, дайте
   доступ к репозиторию `shop-bot`).
2. Название проекта: `shop-bot` (как `name` в `wrangler.jsonc`).
3. Остальное оставьте по умолчанию (команда деплоя `npx wrangler deploy`) и запустите
   деплой. Дождитесь «Success».
4. Запишите адрес бота вида `https://shop-bot.ВАШ-ПОДДОМЕН.workers.dev`
   (показан на странице проекта).

## Шаг 4. Секреты
В проекте: **Settings → Variables and Secrets → Add**, тип **Secret**:
- `BOT_TOKEN` — токен от @BotFather;
- `WEBHOOK_SECRET` — любая длинная строка из латинских букв, цифр, `_` и `-`
  (например `Xk29sLq81mZpR4tVb7`). Запомните её.

## Шаг 5. Подключить Telegram к боту
Откройте в браузере (подставьте адрес и свой WEBHOOK_SECRET):

```
https://shop-bot.ВАШ-ПОДДОМЕН.workers.dev/setup?key=ВАШ_WEBHOOK_SECRET
```

В ответе должно быть `"ok": true`. Делается один раз.

## Шаг 6. Стать админом
1. Напишите своему боту `/id`, он пришлёт ваш Telegram ID.
2. На GitHub в `wrangler.jsonc` впишите в `ADMIN_IDS` ID (несколько через запятую,
   без пробелов): `"ADMIN_IDS": "123456789,987654321"`. **Commit**.
3. Cloudflare сам обновит бота за минуту-две.

## Готово: как пользоваться
- `/admin` → «Добавить товар»: категория, название, цена, остаток, описание, фото.
- Откройте любой товар в каталоге: под карточкой у админа кнопки ➖/➕ остатка,
  правка названия, цены, описания, фото и удаление.
- Покупатели: подтверждение 18+, категории, поиск (просто напишите слово),
  кнопка связи с менеджером. Оплаты в боте нет.
- Команды админа: `/admin`, `/stats`, `/export` (товары файлом), `/cancel`.

## Если что-то не работает
- Бот молчит: откройте проект в Cloudflare → **Logs** и смотрите ошибки; повторите шаг 5.
- Ошибка деплоя про базу: проверьте `database_id` в `wrangler.jsonc`.
- Админ-кнопок нет: ваш ID не попал в `ADMIN_IDS` или обновление ещё не прошло.
- Настройки из `wrangler.jsonc` меняйте на GitHub, а не в панели Cloudflare, иначе
  следующий деплой их перезапишет. Секреты (`BOT_TOKEN`, `WEBHOOK_SECRET`) живут
  только в панели Cloudflare.
