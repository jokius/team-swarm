# Swarm Primitives — cheat sheet для team-swarm паттерна

Быстрая справка по нативному agent-teams API Claude Code (модель **implicit-team**: сессия сама является командой). Не полная документация — только то, что использует этот скилл.

> **Сверено с живой средой 2026-07-22** (эмпирически: ToolSearch из контекста лида И из контекста заспавненного teammate, живые вызовы SendMessage/TaskStop). Если что-то из этого файла не находится через ToolSearch в твоей сессии — верь ToolSearch, а не файлу, и действуй по Preflight-гейту из SKILL.md.

## Чего в API больше НЕТ (не зови — упадёт или не найдётся)

| Убрано | Чем заменено |
|---|---|
| `TeamCreate` / `TeamDelete` | Ничем: команда неявная, живёт с сессией |
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` (общий task-лист) | TodoWrite лида (план/статусы) + назначения в спавн-промптах + отчёты через `SendMessage` |
| Двухтактный shutdown (`shutdown_request` → `shutdown_response`) как способ лида гасить teammates | `TaskStop(<name>)` — мгновенно, без подтверждений. Протокол остался только как legacy: teammate, ПОЛУЧИВШИЙ `shutdown_request`, обязан ответить `shutdown_response{approve:true}` |

`TaskStop` / `TaskOutput` — это управление **фоновыми задачами**, не task-лист. Не путай с убранным `Task*`-семейством.

## Setup / teardown

### Создать team — НЕ нужно
Явного `TeamCreate` нет. Сессия уже является неявной командой: lead — это главный поток Claude Code. Сразу спавнь teammates.

### Спавн teammate
```
Agent({
  name: "tester" | "developer" | "reviewer" | "<worker-name>",
  subagent_type: "general-purpose",
  prompt: "<role brief from role-briefs.md — задача целиком внутри>",
  run_in_background: true
})
```
Спавн — это инструмент **`Agent`**. Имя из `name` — то, по которому к teammate обращаются в `SendMessage` и `TaskStop`. Параметр `team_name` устарел и игнорируется — не передавай. `Agent` возвращает `agent_id` (формат `<name>@session-...`) и `name`.

### Остановка teammate
```
TaskStop({ task_id: "tester" })   // принимает имя напрямую; также agent_id
```
Мгновенно и надёжно. Это штатный способ закрыть этап (respawn-per-stage). Ответ вернёт `task_type: "in_process_teammate"` — значит, остановлен именно teammate.

## Messaging

### Подгрузка схемы
`SendMessage` обычно deferred: перед первым вызовом — `ToolSearch("select:SendMessage")`, иначе InputValidationError.

### Написать одному (по имени!)
```
SendMessage({
  to: "developer",
  summary: "semantic feedback on failing tests",   // 5-10 слов, превью в UI
  message: "<текст сообщения>"
})
```
Обращаться к teammate всегда по **name**, никогда по UUID/agentId (agentId — только если имени нет или имя переиспользовано более новым агентом).

**Адресация lead'а (проверено живьём).** Teammate достучится до lead'а двумя эквивалентными путями, оба работают:
- `to: "team-lead"` — брифы в `role-briefs.md` используют именно его (роутинг подтверждает: sender главного потока = `team-lead`).
- `to: "main"` — документированный канал «фоновый субагент → главный поток».

### Доставка сообщений — автоматическая
Lead **не** читает inbox-файлы и не поллит. Сообщения от teammates приходят сами, новыми ходами. Если lead занят (в середине хода) — сообщения копятся и доставятся по завершении хода. Текстовый вывод teammate'а никому не виден — только `SendMessage` доставляет.

### Broadcast
Отдельного broadcast нет. Нужно оповестить нескольких — пошли каждому `SendMessage` по отдельности.

## Координация работ (вместо убранного task-листа)

- **План и статусы** — TodoWrite лида. Teammates его не видят; это внутренняя бухгалтерия lead'а.
- **Назначение** — спавн-промпт: teammate спавнится под ровно одну задачу (этап/участок), полностью описанную в брифе. Respawn-per-stage делает «claim» ненужным.
- **Статус от teammate** — его `SendMessage`-отчёт лиду («сделал X, файлы Y, вопросы Z»). Структурированные JSON-статусы слать не нужно.
- **Зависимости** — секвенированием: lead просто не спавнит GREEN, пока RED не закрыт.

## Idle и shutdown

### Idle — это норма
Teammate после каждого хода уходит в idle и шлёт автоматическое idle-уведомление (`{"type":"idle_notification",...}`). Idle ≠ «закончил» и ≠ «упал» — он просто ждёт ввода. Idle-teammate можно «разбудить» новым `SendMessage`. Не реагируй на idle, пока он реально не блокирует работу.

### Peer DM visibility
Когда teammate шлёт DM другому teammate (или в main), краткое резюме этого DM приходит lead'у в idle-уведомлении отправителя (`summary: "[to X] ..."`). Отвечать на эти резюме не обязательно.

### Завершение этапа
Teammate прислал финальный отчёт → lead делает `TaskStop(<name>)`. Ждать подтверждений не нужно. Legacy-протокол `shutdown_request`/`shutdown_response` lead больше НЕ инициирует; упоминание в брифах оставлено только на случай, если teammate получит такой JSON со стороны.

## Discovery team-состава
Отдельного объекта команды и `config.json` нет — lead помнит состав сам (он спавнил teammates и знает их `name`). Резюме активных фоновых агентов видно в UI (`/agents` / `/tasks`). Для коммуникации используем `name`, не `agentId`.

## Типичные ошибки

| Ошибка | Причина | Что делать |
|---|---|---|
| `InputValidationError` при вызове SendMessage | Схема deferred-инструмента не загружена | `ToolSearch("select:SendMessage")` |
| Зову `TaskList`/`TaskCreate` — «не найдено» | Их больше не существует | Не звать. Координация — TodoWrite + спавн-промпты + SendMessage (см. выше) |
| `ToolSearch select:TeamCreate,TeamDelete` → «No matching deferred tools» | implicit-team API (старые примитивы убраны) | Это норма, НЕ поломка |
| Teammate «завис» | Ждёт сообщения (idle) или упал | `SendMessage` разбудит idle; не помогло — `TaskStop` и respawn |
| Teammate не остановился | — | `TaskStop(<name>)` останавливает принудительно, подтверждение не требуется |

## Полная документация

Это только cheat sheet для team-swarm паттерна. Полная механика Claude Code agent teams — в official docs. При расхождении этого файла с живой средой — среда права; обнови файл.
