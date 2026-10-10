# Fan-out на Workflow — бэкенд исполнения для режима B

Содержание:
- Перед запуском — основание вызова, подтверждение, размер прогона, раскладка
- Скрипт и вызов — `pipeline()` apply → review, схемы, маркеры упавших участков
- Во время и после прогона — восстановление, интеграция, REJECT'ы
- Изоляция — disjoint-наборы файлов и аварийный выход через worktree
- Соответствие фолбеку и синхронизация промптов с `role-briefs.md`

Runbook Workflow-бэкенда режима B. Ты читаешь этот файл, потому что lead уже выбрал режим B и инструмент `Workflow` доступен. Гейт выбора бэкенда, оценка уместности команды и фолбек (agent-teams) — в `SKILL.md → «Режим B: Fan-out»`.

Концепция fan-out общая для обоих бэкендов (владение участками, контракт-спека, гейт = сборка+тесты). Workflow-бэкенд меняет только то, чем раздаются и сшиваются участки: один скрипт-оркестратор фанит агентов через `pipeline()` детерминированно, без team-механики (ни спавна teammates через `Agent`, ни `SendMessage`, ни `TaskStop`). Структурный вывод вместо парсинга сообщений, поток держит скрипт, прерванный прогон восстанавливается по `runId`.

## Перед запуском

### Основание и подтверждение

Живое правило инструмента: вызов `Workflow` легитимен, когда пользователь вызвал скилл, чьи инструкции велят вызвать Workflow. «Вызвал» значит: сам попросил команду или сворм, набрал `/team-swarm` или держит постоянную инструкцию (CLAUDE.md) работать через team-swarm. Если скилл включился без такого запроса — одной строкой скажи пользователю, что запускаешь fan-out через Workflow и на сколько участков.

Основание не отменяет подтверждения: запуск может спросить его по режиму прав. В ручном режиме скрипт, написанный под задачу, подтверждается на каждый прогон (пункт «don't ask again» предлагается только для встроенных, сохранённых и плагинных workflow, вызванных по имени). В `-p` и Agent SDK диалога нет — нужен allow-rule на `Workflow` (или auto/bypass-режим). Пользователь может выключить Workflow (`disableWorkflows: true` в settings, `CLAUDE_CODE_DISABLE_WORKFLOWS=1`) — тогда идём в фолбек.

### Размер прогона

Живой гайдлайн размера на настройке medium — держать workflow меньше 10 агентов (пользователь меняет её в `/config` → Dynamic workflow size). Одновременно бегут не больше `min(16, CPU−2)` агентов (меняется `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`), остальные ждут в очереди. Лимит `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` на агентов workflow не распространяется, так что размер держит раскладка лида.

Скрипт тратит два агента на участок (apply + review), отсюда дефолт — до 4 участков за прогон: пять — уже 10 агентов, за гайдлайном. Участков больше — укрупни их (несколько модулей в один участок, наборы файлов всё так же не пересекаются) или гони батчами: несколько прогонов по 4 участка подряд, интеграция после каждого. Причина: узкое место — задержка и число агентов; сверх потолка всё встаёт в очередь, а каждый лишний агент — ещё одна сборка контекста с нуля.

`model` и `effort` в `agent()` не задаём: цель скилла — задержка, а не экономия токенов, и понижать модель отдельным стадиям незачем.

### Раскладка (судейская работа, в контексте лида)

Та же раскладка, что в фолбеке; Workflow её не делает. Скаут inline, потом фанишь:

1. Режь на disjoint-участки. Множества файлов участков не пересекаются — это и есть анти-гонка: агенты пишут реально параллельно в одно дерево, и разводит их только непересечение наборов. Участок = `{ name, files: [...], instructions, build? }`, где `build` — команда сборки только этого участка (не задашь — воркер подберёт самую узкую сам и отчитается, чем собирал).
2. Выдели shared-зону лида. Файлы, которые трогает несколько участков (точки сборки/DI `cmd/*`, корень рефакторимого пакета, общие контракты), не отдаются ни одному агенту — их правит lead на интеграции, после скрипта.
3. Напиши контракт. `specs/contract.md` (или строкой): одна строка «зачем это изменение», единые имена/расположение/сигнатуры, паттерн правки и один эталонный пример «до/после». Это единственный источник правды по стилю: вопросов посреди прогона агент задать не сможет, так что всё, что ему нужно, должно быть здесь.

## Скрипт

`sectors` и `contract` lead передаёт через `args` реальным JSON-объектом, не строкой (строка доходит до скрипта одной строкой, и `.map` по ней падает). Тот же скрипт переиспользуется на любую fan-out задачу. Промпты агентов — на английском и самодостаточны: агент workflow не знает ни файлов скилла, ни имён переменных скрипта, поэтому правила вписаны прямо в промпт, а переменные входы обёрнуты в XML-теги.

```js
export const meta = {
  name: 'fanout-refactor',
  description: 'Применить контракт по непересекающимся участкам + ревью каждого участка',
  phases: [
    { title: 'Apply',  detail: 'каждый воркер правит свой участок по контракту' },
    { title: 'Review', detail: 'проверка контракта и владения по каждому участку' },
  ],
}

const sectors  = args.sectors    // [{ name, files: [...], instructions, build? }] — files не пересекаются между участками
const CONTRACT = args.contract   // текст контракта или путь specs/contract.md

const APPLY_SCHEMA = {
  type: 'object',
  required: ['sector', 'files_changed', 'build_command', 'build_output_tail', 'compiles'],
  properties: {
    sector:            { type: 'string' },
    files_changed:     { type: 'array', items: { type: 'string' } },
    build_command:     { type: 'string' },                             // заземление: чем именно собирал
    build_output_tail: { type: 'string' },                             // хвост вывода этой сборки
    compiles:          { type: 'boolean' },                            // true только если эта сборка прошла
    shared_file_needs: { type: 'array', items: { type: 'string' } },   // нужен файл вне участка → сюда, не править
    contract_gaps:     { type: 'array', items: { type: 'string' } },   // где контракт не покрыл случай
    follow_ups:        { type: 'array', items: { type: 'string' } },   // замеченное вне паттерна, не правилось
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['sector', 'verdict'],
  properties: {
    sector:      { type: 'string' },
    verdict:     { type: 'string', enum: ['APPROVE', 'REJECT'] },
    issues:      { type: 'array', items: { type: 'string' } },   // блокирующие, плоские actionable-строки, без тега [to: ...]
    minor_notes: { type: 'array', items: { type: 'string' } },   // не блокируют
  },
}

const applyPrompt = (s) => [
  `You are a fan-out worker for sector "${s.name}". You apply one agreed mechanical change (a refactor or migration) to the files of this sector. This is not feature work and not test writing.`,
  ``,
  `<contract>`, CONTRACT, `</contract>`,
  `<files>`, s.files.join('\n'), `</files>`,
  `<sector_instructions>`, s.instructions || '(none beyond the contract)', `</sector_instructions>`,
  ``,
  `Rules:`,
  `- The contract is the single source of truth for naming, placement, signatures and the change pattern. Follow its before/after example literally, so that all sectors fit together at integration. If <contract> holds a file path, read that file first.`,
  `- Edit only the files listed in <files>. Other workers are editing other files of this same tree right now, so a write outside your list can overwrite their work. Reading any file for context is fine.`,
  `- Shared files (build/DI entry points, the core of the refactored package, common contracts) belong to the lead. If you need a change outside <files>, do not make it: add "<path>: <what and why>" to shared_file_needs.`,
  `- Preserve behavior beyond the contract's pattern. Change only what the pattern requires and leave unrelated improvements out, even small ones: the reviewer rejects edits outside the pattern. If you spot something worth fixing, add it to follow_ups instead.`,
  `- If a language or framework skill for this stack is available, use it for the idioms of the change.`,
  `- Do not commit, push, stash, reset, checkout or clean: other workers' uncommitted edits share this working tree, and those commands would move or destroy them. Read-only git (status, diff -- <your file>) is fine.`,
  `- Nobody can answer questions during this run. Apply what the contract defines unambiguously. Where it does not cover a case, do not guess: leave that spot unchanged and describe it in contract_gaps.`,
  `- Before finishing, build only your sector with ${s.build ? 'this command: `' + s.build + '`' : 'the narrowest command that builds your files (their package or module)'}. Put the exact command in build_command and the last ~20 lines of its output in build_output_tail; set compiles to true only if that run succeeded.`,
  ``,
  `Return the structured result, with sector set to exactly "${s.name}".`,
].join('\n')

const reviewPrompt = (s, applied) => [
  `You are the reviewer for fan-out sector "${s.name}": a mechanical refactor or migration with no new tests. The contract is the spec. You judge the change; you do not edit files.`,
  ``,
  `<contract>`, CONTRACT, `</contract>`,
  `<files>`, s.files.join('\n'), `</files>`,
  `<changed_files>`, (applied.files_changed || []).join('\n'), `</changed_files>`,
  ``,
  `<files> is what the worker owns; <changed_files> is what it reports changing. Read the actual diff of these files (for example git diff -- <file>), not just the list. If <contract> holds a file path, read that file first.`,
  `Check:`,
  `1. Contract adherence: naming, placement, signatures and the change pattern match the contract and its before/after example.`,
  `2. Behavior is unchanged beyond the agreed pattern.`,
  `3. Ownership: every changed file is listed in <files>.`,
  `4. No edits outside the pattern ("while I was here" changes).`,
  `If a review skill for this stack is available, use it as a checklist; skip any skill that spawns its own agents.`,
  ``,
  `REJECT only for a contract violation, a bug that produces wrong behavior, an ownership violation, or an edit outside the pattern. Each issue is one actionable line: what to fix and why. Everything else goes to minor_notes and does not block.`,
  `Return the structured result, with sector set to exactly "${s.name}".`,
].join('\n')

// pipeline, а не parallel-барьер: участок B уже ревьюится, пока C ещё применяется.
const results = await pipeline(
  sectors,

  // Stage 1 — Apply. Первая стадия получает сам элемент.
  // .catch → упавший агент даёт null, а не throw: брошенная стадия превратила бы весь элемент в безымянный null
  // и пропустила бы stage 2, а так участок доходит до stage 2 и помечается failed со своим именем.
  (s) => agent(applyPrompt(s), { label: `apply:${s.name}`, phase: 'Apply', schema: APPLY_SCHEMA })
    .catch(() => null),

  // Stage 2 — Review. Поздние стадии получают (prevResult, originalItem, index).
  // Apply упал/скипнут или вернул чужой участок (схема на каждом agent() — чтобы чужой вывод не пролез молча) →
  // ревьюера не спавним, отдаём маркер failed. Упавший ревьюер → review: null, участок всё равно в результатах.
  (applied, s) =>
    applied == null || applied.sector !== s.name
      ? { sector: s.name, applied, review: null, failed: true }
      : agent(reviewPrompt(s, applied), { label: `review:${s.name}`, phase: 'Review', schema: REVIEW_SCHEMA })
          .catch(() => null)
          .then((review) => ({ sector: s.name, applied, review, failed: false }))
)

// Не фильтруем по Boolean: каждый участок должен быть представлен — упавшие как { failed: true },
// чтобы lead на интеграции увидел, какой участок не отработал, а не просто недосчитался.
return results
```

Вызов (lead, его main loop):

```
Workflow({ script: "<скрипт выше>", args: { sectors, contract } })
```

> Reviewer agentType. Если стоит `compound-engineering` и участок того стоит, review-стадии можно дать `agentType` одного из агентов без JSON-only вывода — `compound-engineering:review:ce-security-sentinel`, `…:ce-performance-oracle`, `…:ce-architecture-strategist` — в опциях `agent()`. Персоны `ce-*-reviewer` требуют свой JSON и спорят с `REVIEW_SCHEMA` (SKILL.md → «Архитектура»). По умолчанию — дефолтный агент workflow.
>
> «Без reviewer». Замени stage 2 функцией без `agent()`: `(applied, s) => ({ sector: s.name, applied, review: null, failed: applied == null || applied.sector !== s.name })`. Так маркеры упавших участков сохраняются, а агентов на участок — один, и за прогон влезает вдвое больше участков.

## Во время и после прогона

### Пока прогон идёт

**Агенту workflow никогда не пиши `SendMessage`: он не зарегистрирован как живая задача, и сообщение поднимает вторую копию из его транскрипта, которая пишет в те же файлы параллельно с оригиналом (#93797).** Вся связь — через результат скрипта и схемы; поправка участка — новым прогоном (ниже).

Схема стоит на каждом `agent()` не только ради удобного разбора: известен баг, когда `agent()` возвращал прозу из чужой параллельной сессии (#96546). Со схемой такой ответ не проходит валидацию, а сверка `sector` в stage 2 ловит ответ не про тот участок.

### Восстановление прерванного прогона

Прогон прервался (лимит использования, kill, пауза) — перезапусти его: `Workflow({ scriptPath, resumeFromRunId })`. И путь к сохранённому скрипту, и `runId` есть в результате прошлого вызова. Самый длинный неизменённый префикс вызовов `agent()` вернётся из кэша, первый изменённый или новый вызов и всё после него пойдут вживую; тот же скрипт с теми же `args` — полное попадание в кэш. Результат выглядит странно (пустой, не про тот участок) — сначала прочитай `journal.jsonl` в каталоге транскрипта прогона: там то, что реально вернул каждый агент. `resumeFromRunId` — для прерванного прогона; поправка участка по REJECT — это новый прогон по подмножеству.

### Интеграция (в контексте лида)

Скрипт — чистый JS: файлы он не правит и общую сборку не гоняет. Это делает lead, и именно тут живёт инвариант «shared-файлы правит только lead»:

1. Сверь покрытие. В `results` должен быть каждый участок из `sectors`. `null` на месте участка, `failed: true` (apply упал, скипнут или вернул чужой участок) или `review: null` — участок не прошёл полный путь: обработай по п.5, fan-out не считай полным. Сверь и дерево: `git status` против объединения наборов участков — изменённый файл вне них, которого не правил ты сам, означает нарушение владения. `files_changed` агент заполняет сам, это заявление, а не доказательство.
2. Собери результаты по успешным участкам: `applied` (с `build_command` и хвостом вывода — чем подтверждена локальная сборка) + `review`.
3. Обработай `shared_file_needs[]` и shared-зону. Все запросы на чужие файлы и точки сборки/DI/корень пакета правит lead, последовательно, в реальном дереве.
4. Гейт. Прогони полную сборку + существующие тесты (+ линтер, если настроен) — это гейт качества fan-out вместо RED/GREEN. Твои собственные shared-правки (п.3) не проходили per-участок ревью — под ними только сборка и тесты; при риске отдай их на review свежему субагенту через `Agent`, не форку: форк унёс бы рассуждения лида, а судье нужен взгляд со стороны (в main loop лида функции `agent()` нет, она существует только в теле Workflow-скрипта).
5. REJECT'ы и упавшие участки:
   - Точечный REJECT или упавший участок → новый прогон того же скрипта с `sectors` = только эти участки; issues ревьюера допиши в `instructions` участка. Старым агентам ничего не пиши (см. выше).
   - Системный REJECT (контракт дырявый, расходятся многие участки) или `contract_gaps[]` от воркеров → поправь `contract.md` и перезапусти скрипт по затронутым участкам.
6. Завершение. Останавливать и распускать некого: Workflow-бэкенд команду не поднимает. Если были worktree — прибери их (см. «Изоляция»). Финальный отчёт: участки, файлы, что свёл lead, результат сборки/тестов, известные ограничения, `follow_ups` воркеров.

## Изоляция

Disjoint-наборы файлов в одном дереве, без worktree. Агенты пишут в разные файлы → конфликтов нет по построению; держат это раскладка лида и правило владения в apply-промпте (читать чужое можно, писать — только своё). Если участки не режутся на непересекающиеся наборы — это сигнал, что раскладка неверная: пересмотри границы или отдай спорные файлы в shared-зону лида, а не разруливай параллельную запись.

Аварийный выход — `isolation: 'worktree'` в опциях apply-`agent()` участка, который иначе не развести. Подводные камни:
- worktree по умолчанию ветвится от `origin/<default>`, а не от локального HEAD: незапушенные коммиты лида агент не увидит, пока в settings не стоит `worktree.baseRef: "head"` (#88967: тесты зелёные на устаревшем дереве). Worktree строится от коммита, так что незакоммиченные правки лида (в том числе свежий `specs/contract.md`) туда не попадут — передай контракт текстом.
- правки агента остаются в его worktree: до сведения их не видят ни ревьюер в основном дереве, ни сборка лида. Поэтому вердикт stage 2 по такому участку не в счёт: сведи правки на интеграции и проверь участок уже в основном дереве.
- чистые worktree не всегда удаляются сами (#95644): после прогона `git worktree list` и убери лишние.

## Соответствие фолбеку

Концепция и инварианты те же (раскладка на disjoint, контракт, shared — только lead, гейт = сборка+тесты). Различаются механики координации:

| Аспект | Workflow-бэкенд | Agent-teams бэкенд (фолбек) |
|---|---|---|
| Координация потока | детерминированный скрипт (`pipeline`) | план лида + `SendMessage` + `TaskStop` |
| Связь с агентом в работе | нет: только результат по схеме; `SendMessage` агенту workflow запрещён | `SendMessage` в обе стороны |
| Запрос чужого файла / дыра в контракте | `shared_file_needs[]` / `contract_gaps[]` в результате, спорное место не трогается | `SendMessage` лиду |
| Co-review лида | на интеграции (разбор `applied` + `review` после скрипта) | параллельно, по мере готовности участка |
| Размер | до 4 участков за прогон (гайдлайн — меньше 10 агентов), больше — укрупнять или батчами | до 5 одновременных воркеров, больше участков — укрупнять или по нескольку на воркера |
| Повтор участка | новый прогон по подмножеству; прерванный прогон — `resumeFromRunId` | доработка тем же воркером, пока он жив; иначе `TaskStop` и `worker-<sector>-r2` с обновлённым брифом |
| Завершение | останавливать некого; прибрать worktree, если были | `TaskStop` всем ещё живым воркерам |

## Промпты агентов

`applyPrompt`/`reviewPrompt` — самодостаточная англоязычная выжимка `role-briefs.md → «Fan-out worker brief» и «Reviewer brief» (его REJECT bar и «What to check in fan-out mode»)`: правила вписаны прямо в промпт, минус team-механика (нет `SendMessage`/`TaskStop` — поток держит скрипт, вопросы уходят в `contract_gaps`) и минус тег `[to: ...]` в вердикте (ролей-получателей нет, любой REJECT уходит в новый прогон apply по этому участку). Правишь правила воркера/ревьюера в `role-briefs.md` — синхронь содержательную часть сюда, без team-специфики.
