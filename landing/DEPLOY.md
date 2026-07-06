# Деплой лендинга SkillCue

Лендинг — статика, папка `landing/` целиком (index.html, oferta.html, privacy.html,
robots.txt, sitemap.xml). Два пути на выбор.

## Путь A: свой VPS (nginx) — раз уж сервер уже есть

Промпт для Claude-сессии с SSH-доступом:

```text
Задеплой статический лендинг из папки landing/ этого проекта на мой VPS <IP>
(ssh <user>@<IP>). Домен: <ДОМЕН>, DNS уже указывает/скоро укажет на сервер.
1. Поставь nginx, скопируй landing/ в /var/www/skillcue (без DEPLOY.md).
2. Серверный блок: root /var/www/skillcue, index index.html, gzip on,
   кэш статики 7d, server_name <ДОМЕН> www.<ДОМЕН>.
3. HTTPS: certbot --nginx, автопродление.
4. Перед копированием замени во всех файлах "ВАШ-ДОМЕН" на <ДОМЕН> и
   раскомментируй canonical/og:url в index.html.
5. Проверь: https://<ДОМЕН>/ отдаёт 200, /oferta.html и /privacy.html открываются,
   /robots.txt и /sitemap.xml на месте.
```

## Путь B: Cloudflare Pages (без сервера, 10 минут)

dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets →
перетащить папку `landing/` → Deploy → Custom domains → добавить домен.

## После деплоя (не забыть!)

- [ ] Заменить `ВАШ-ДОМЕН` в index.html (canonical), robots.txt, sitemap.xml
- [ ] Яндекс.Метрика: код счётчика в index.html (место помечено комментарием перед </body>)
- [ ] Вписать реквизиты самозанятого в oferta.html и privacy.html (метки [ВПИСАТЬ])
- [ ] Яндекс.Вебмастер + Google Search Console: добавить сайт, скормить sitemap
- [ ] Кинуть ссылку в Telegram себе — проверить OG-превью
