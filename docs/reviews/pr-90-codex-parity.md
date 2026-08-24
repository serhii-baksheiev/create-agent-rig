# Ревью PR #90 — Codex parity foundation (AR-113)

Измеренное ревью: что закрыли раунды правок и что осталось открытым.
Каждое утверждение ниже либо перепроверено запуском, либо помечено как
непроверенное.

|           |                                                                             |
| --------- | --------------------------------------------------------------------------- |
| PR        | [#90](https://github.com/serhii-baksheiev/create-agent-rig/pull/90) — draft |
| Ветка     | `feat/AR-113-codex-parity-foundation`                                       |
| head      | `fb35eb0`                                                                   |
| base      | `a04d6ab` (= `origin/master`, 10 коммитов вперёд)                           |
| Проверено | 2026-08-19, раунды 1–3                                                      |

## Вердикт: обе мои находки закрыты

**Раунд 2, на `38729bb`.** Оба блокера из первой версии этого брифа исправлены —
перепроверил измерением, а не по диффу. Осталось два мелких пункта, ни один из
них не блокирующий.

|                               |                                |
| ----------------------------- | ------------------------------ |
| Мои блокеры                   | **2 → 0**                      |
| Мелкое, открытое              | **2**                          |
| Механических проверок зелёные | **6 / 6**, CI 4/4 на `38729bb` |

### 3.1 — число секций: 86.5 с → 0.22 с

`38729bb` добавил `MAX_PATCH_SECTIONS = 128`, `MAX_PATCH_PATH_COMPONENTS = 512`
и кэш `resolvedDirectories`. Те же четыре зонда, что дали 13.8–86.5 с:

| Глубина пути | Секций |   Было |                             Стало |
| -----------: | -----: | -----: | --------------------------------: |
|            1 | 29 956 | 13.8 с |     **0.24 с** — отказ по секциям |
|            8 | 21 397 | 28.9 с | **0.18 с** — отказ по компонентам |
|           40 |  9 278 | 57.6 с | **0.17 с** — отказ по компонентам |
|          120 |  3 840 | 86.5 с | **0.22 с** — отказ по компонентам |

Тесты правильной формы: читают константу из исходника, а не хардкодят число, и
проверяют, что обработка **останавливается** (часовой `../../must-not-resolve.ts`
не даёт отказу подмениться другим) и что сообщение не приписывает чужую причину.

### 3.2 — сообщение больше не врёт, и правило догнало код

Тот же патч 1.32 MB только по `docs/big.md`:

```
BLOCKED — cannot safely inspect this edit: apply_patch command exceeds the
1048576-character inspection limit
Split it into a smaller patch and retry.
```

Вместо «packages/core is a pure module and this change breaks its purity».
Причина названа своя, и есть выполнимый совет.

`invariants.md` получил абзац, которого не хватало:

> **Refusing bounded inspection is a third outcome, not a match or an error.** If
> the payload shape is understood but safely inspecting it would cross an explicit
> work bound, the hook blocks without claiming that its protected invariant was
> violated.

Это ровно та граница, про которую другой ревьюер писал, что она «written down
nowhere»: непонятая форма payload'а → allow, понятая но превышающая бюджет →
block. Теперь записана.

### Что закрылось из моих не блокирующих

- **§4.1 Bash-поверхность.** Закрыто цитатой: `docs/decisions/codex-adapter.md`
  ссылается на документацию Codex, где `tool_input.command` — строка и для
  `Bash`, и для `apply_patch`. Соответственно `2371b65` **убрал** разбор
  argv-массивов, добавленный в `46f8147`. Проверил: `bash -cx "git push --force
origin master"` и `bash -c -x "…"` теперь блокируются (exit 2) — заявленный
  обход `/^-[^-]*c$/` не воспроизводится.
- **§4.3 README.** Формулировка про Codex-trust теперь несёт указатель на
  документацию — это один из двух разрешённых выходов из `UNMEASURED`, а не
  смягчение.
- **Прозаический блокер про `autonomy.md`.** Строка 98 теперь говорит
  «`Write`, `Edit`, or `apply_patch`» — понимание и отказ больше не расходятся.

---

## Осталось открытым

### O1. ~~Связь «глубина × число файлов» нигде не описана~~ — ЗАКРЫТО в `fb35eb0`

`MAX_PATCH_PATH_COMPONENTS = 512` считает **сумму компонентов по всему патчу**,
поэтому фактический потолок по числу файлов зависит от глубины дерева. Измерено
на обычном пути `packages/core/src/domain/mN.ts` (5 компонентов):

| Файлов в патче | Результат                                                          |
| -------------: | ------------------------------------------------------------------ |
|             50 | ok                                                                 |
|             80 | ok                                                                 |
|            100 | ok                                                                 |
|        **103** | **BLOCKED — path component count exceeds the 512-component limit** |
|            130 | BLOCKED                                                            |

Сам этот PR трогает 84 файла, так что кодмод по монорепе легко перешагнёт порог.

**Как закрыто:** `fb35eb0` добавил в `docs/decisions/codex-adapter.md` абзац,
который называет ровно это — агрегатность бюджета, падение вместимости с ростом
глубины и что делать («split the edit into multiple smaller patches»). Пин —
тест `codex.test.ts › "documents how the aggregate path-component budget limits
files per patch"`.

⚠ **Поведение не изменилось**: патч на 103 файла по-прежнему получает отказ.
Лимит задокументирован, а не поднят. Это законное закрытие — я сам писал, что
это не блокер, — но если такой патч встретится в работе, решение (поднять
потолок или считать секции отдельно от компонентов) придётся принимать заново.

### O2. ~~Заголовок `edit-input.mjs` перечисляет пять границ, а их семь~~ — ЗАКРЫТО в `fb35eb0`

Было:

```
Inspection is bounded globally per patch: sources, hunks, output, splices and comparisons.
```

Стало — добавлены `sections` и `path components`, две границы, ради которых
предыдущий коммит и делался. Пин — тест `codex.test.ts › "names all seven
per-patch inspection budgets in the normalizer header"`.

⚠ **Что этот тест ловит, а что нет.** Список из семи бюджетов в нём — ручной
массив, поэтому он падает, если бюджет **исчез** из заголовка, но восьмой
добавленный бюджет его не уронит. Разрыв в том же направлении, из-за которого O2
и возник.

### O3. Метки `human-review` нет — открыто, и это действие человека

`detect-missed-gate.mjs` гасит находку **только меткой**: текст PR не считается,
потому что его пишет тот же, кого аудируют. Меток на PR ноль.

Codex её сознательно не ставил (§7): метка — внешнее свидетельство ревью, и автор
исправления не должен создавать это свидетельство за ревьюера. Ставит владелец
репозитория или ревьюер с triage-правами.

---

## 1. Что говорит механика

Всё запущено на этой ветке, не взято из тела PR.

| Проверка                                      | Результат | Деталь                                                                |
| --------------------------------------------- | --------- | --------------------------------------------------------------------- |
| `node scripts/sync-codex-adapter.mjs --check` | exit 0    | дрейфа между проекциями нет                                           |
| `node scripts/sync-agent-os.mjs --check`      | exit 0    | рулбук собран из шаблонов                                             |
| `node scripts/validate-no-secrets.mjs`        | clean     | 380 отслеживаемых файлов                                              |
| `pnpm typecheck`                              | clean     | оба tsconfig                                                          |
| `pnpm lint`                                   | clean     | eslint + prettier                                                     |
| CI на GitHub                                  | 4 / 4     | `ci`, `template-aws-serverless`, `template-node-service`, GitGuardian |

Маршрутизация:

| Что                                    | Значение                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| `decision-router --base origin/master` | lane **MODEL** — риск-флаги `elevated-path`, `security-surface` |
| Ревьюеры, которые полагаются           | `code-reviewer`, `prose-reviewer`, `security-scanner`           |
| Метки на PR                            | **нет ни одной**                                                |

---

## 2. Закрыто по прошлым раундам

| Ссылка                 | Находка                                                                                                | Чем закрыта                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| часть 1 §1             | Ветка на устаревшей базе, merge проходит чисто                                                         | merge-base = `origin/master`                                                                                  |
| часть 1 §2             | Генерируемые проекты не объявляют Codex-рулбук elevated                                                | `.agents/`, `.codex/`, `AGENTS.md` в universal-блоке `elevated-paths`                                         |
| часть 2 §1             | Путь не нормализуется — guard обходится опечаткой                                                      | `canonicalPatchPath` режет абсолютные, `..`, drive-letter                                                     |
| часть 2 §2             | FIFO в патче вешает guard навсегда                                                                     | `O_NOFOLLOW` + `fstat`, отказ на не-регулярном файле                                                          |
| часть 2 §3             | Цикл удалений O(N·M) — 15 с на 3 МБ патча                                                              | KMP-поиск вместо `content.replace`                                                                            |
| часть 2 §4–5           | Чтение вне репозитория, содержимое эхом в stderr                                                       | резолв от git-корня, `lstat` + сверка `dev`/`ino` против TOCTOU                                               |
| часть 2 §7, часть 3 §5 | `upgrade` не защищал `.codex/hooks.json`                                                               | `WIRING_PATHS` + `wiringByPath`, per-path                                                                     |
| часть 3 §1             | Общий нормализатор в слое `architecture`, а нужен он `process`                                         | `edit-input.mjs` перенесён в `process`                                                                        |
| часть 3 §3–4, §6–7     | `.agents/` невидим гейтам; `sandbox_mode` по магическому имени; расхождение доков; нет decision record | `decision-router.mjs:221`, `detect-missed-gate.mjs:149`; вывод из `tools:`; `docs/decisions/codex-adapter.md` |

---

## 3. Новое, блокирующее

### 3.1 Число секций в патче ничем не ограничено — 86 секунд внутри fail-open хука

**Файл:** `.claude/hooks/lib/edit-input.mjs`
**Статус:** воспроизведено измерением

Бюджеты, которые ввёл этот PR — `movedBytes`, `hunkLines`, `comparisons`,
`splices` — покрывают только путь moved-файла. `repositoryPatchPath` вызывается
**на каждую секцию** патча и поднимается `realpathSync`/`lstatSync` по
компонентам пути. Этого не считает никто.

Патч ровно под `MAX_PATCH_CHARACTERS` (1 MiB), рабочая директория — этот репозиторий:

| Глубина пути | Секций |      Размер | Время в хуке |
| -----------: | -----: | ----------: | -----------: |
|            1 | 29 956 |      ~1 MiB |   **13.8 с** |
|            8 | 21 397 |      ~1 MiB |   **28.9 с** |
|           40 |  9 278 |      ~1 MiB |   **57.6 с** |
|          120 |  3 840 | 1 048 320 B |   **86.5 с** |

Глубина 1 — это обычная строка `*** Add File: x.ts`, не экзотика: 30 тысяч таких
секций дают 13.8 с. И три guard'а сидят на одном matcher'е
`Write|Edit|apply_patch`, то есть цена платится трижды за один вызов.

> «…the test is not “is it fast enough on realistic input” but **“can any input
> make it do unbounded work at all”**.» — `.claude/rules/invariants.md`

Хук, который встал, fail-open'ит не своё правило, а **все три** — ровно тот класс
дефекта, за который заплатил `docs/decisions/fail-open-guards.md`.

**Наименьший фикс:** счётчик секций в `budget` + кэш уже разрезолвленных
каталогов. Пути внутри одного патча почти всегда делят префикс, так что кэш
убирает и повторные syscall'ы, и мотив для отдельного лимита на глубину.

### 3.2 Fail-open сменили на fail-closed молча, и сообщение об отказе называет не ту причину

**Файлы:** `guard-core-purity.mjs`, `guard-web-boundary.mjs`, `guard-secret-file.mjs`
**Статус:** воспроизведено запуском

Патч на 1 320 026 байт, трогающий **только** `docs/big.md`:

```
guard-core-purity   exit=2  BLOCKED — packages/core is a pure module and this
                              change breaks its purity:
                                - cannot safely inspect this patch — apply_patch
                                  command exceeds the 1048576-character limit
guard-web-boundary  exit=2  BLOCKED — apps/web imports the domain (core, shared),
                              never the backend:
                                - "cannot safely inspect this patch — …
guard-secret-file   exit=2  BLOCKED — cannot safely inspect this edit: …
```

Здесь два разных дефекта в одном месте.

1. **Правило и код противоречат.** `invariants.md` по-прежнему говорит: _«Fail
   closed on a match, fail open on an error. If the hook itself throws or gets a
   payload it does not understand, it must allow the edit.»_ PR ввёл третье
   состояние — отказ от инспекции блокирует. Возможно, это правильный выбор; но
   правило о нём не знает, а +6 строк, которые PR внёс в `invariants.md`, про
   другое (upstream-тесты). По стандарту самого репозитория это
   `prose-reviewer`-блокер.
2. **Guard ставит ложный диагноз на честной работе.** Файл не в `packages/core`
   и не в `apps/web`, а текст отказа наследует шапку инварианта. Большой честный
   патч — лок-файл, сгенерированный бандл, крупная фикстура — будет заблокирован
   с неверной причиной и без выполнимого совета.

**Наименьший фикс:** отдельное сообщение для refusal, без шапки инварианта, плюс
абзац в `invariants.md`, который назовёт refusal-to-inspect третьим состоянием и
объяснит, почему оно блокирует.

---

## 4. Открытое, не блокирующее

### 4.1 ~~Bash-поверхность Codex~~ — ЗАКРЫТО на `38729bb`, см. выше

`guard-bash.mjs:814` и `block-no-verify.mjs:25` требуют строку —
`typeof commandValue !== 'string' → return 0`. Часть 2 §6 ревью утверждала, что
shell-инструмент Codex несёт argv-массив.

**У меня нет payload'а Codex, и я это не проверял.** В PR тоже нет ни цитаты на
схему, ни теста: `codex.test.ts` проверяет только наличие группы
`matcher: "Bash"` и форму команды. Для `apply_patch` тот же вопрос закрыт
нормализатором и тестом — асимметрия заметная.

Достаточно одной строки в `docs/decisions/codex-adapter.md` со ссылкой на
документированную форму payload'а, либо теста.

### 4.2 Нет метки `human-review` — открыто

PR пересекает шесть объявленных elevated-путей, router даёт `MODEL`.
`detect-missed-gate.mjs` гасит находку **только меткой**: текст PR не считается,
потому что его пишет тот же, кого аудируют. Меток на PR нет ни одной.

### 4.3 ~~Абзац про Codex-trust~~ — ЗАКРЫТО на `38729bb`, см. выше

`README.md:42–45` — «if Codex presents a trust prompt», «may require that review
again». `invariants.md` прямо называет два выхода из `UNMEASURED` — удалить
предложение или превратить его в указатель — и отдельно оговаривает, что
смягчение формулировки выходом не является.

### 4.4 ~~Соответствие тексту задачи AR-113~~ — ОТВЕЧЕНО, см. §7

Проверка _«не противоречит ли изменение элементу очереди, который оно
реализует»_ не запускалась, потому что текст задачи в ревью не передавался.

Codex закрыл это в §7: текст `AR-113` получен из Jira напрямую и сверен со scope
и acceptance criteria. **Сам текст задачи в бриф не попал**, поэтому с моей
стороны это принято на слово — единственный пункт во всём документе с таким
статусом.

## 5. Про локальный прогон тестов

Чтобы цифры «44–53 падения» не читались как находка.

| Прогон                    | Результат           | Дерево / head                  |
| ------------------------- | ------------------- | ------------------------------ |
| `pnpm test:unit`          | 47 fail / 1728 pass | чистое, `2371b65`              |
| `pnpm test:unit`          | 44 fail / 1731 pass | + untracked бриф, `2371b65`    |
| `pnpm test:unit`          | 45 fail / 1730 pass | чистое, 0 путей в `git status` |
| `pnpm test:unit`          | 46 fail / 1736 pass | `38729bb`                      |
| `pnpm test:unit`          | 53 fail / 1731 pass | `fb35eb0`                      |
| `pnpm test:unit`          | 48 fail / 1736 pass | `fb35eb0`, тот же tree         |
| Прицельно `codex.test.ts` | 56 / 57             | `fb35eb0`                      |
| CI на Linux               | 4 / 4               | `2371b65`, `38729bb`           |

Две последние строки полного прогона — **один и тот же tree, одна и та же сюита
(1786), 53 и 48 падений.** Пять тестов «починились» без единого изменения в коде.

Три вывода, и все три измерены, а не выведены из вида ассертов:

1. **Счётчик гуляет между идентичными прогонами** — 44 / 45 / 47 без единого
   изменения в коде. Это подпись таймаутов под параллельной нагрузкой
   (`testTimeout` 5 с), а не детерминированного дефекта.
2. **`os.homedir()` не видит `$HOME` на этом хосте.** Проверено:

   ```
   HOME env      = C:\Users\SERHII~1\AppData\Local\Temp\fake-home
   os.homedir()  = C:\Users\SerhiiBaksheiev
   honoured      = false
   ```

   Отсюда падают все кейсы `guard-hardening` и `stop-flag`, которые подменяют
   домашнюю директорию, чтобы проверить тормоз.

3. **`chmod` здесь не влияет на доступ.** Проверено:

   ```
   mode 0o000, still readable = true
   dir  0o500, still writable = true
   ```

   Отсюда падает ровно тот список, который печатает `gate-stop-dod`:
   `github-issues.mjs escalates when the run directory is unwritable`,
   `leaves the state file readable only by the run that owns it`,
   `hands back the count that is really on disk when it could not write`.

Остальное — симлинки и `npm publish --dry-run`, тоже семантика хоста.

**Что это НЕ отменяет.** Baseline на `master` поднять не удалось (pnpm-шные
`node_modules` не переносятся в worktree), так что «на `master` было бы столько
же» я не проверял. Проверено другое и более прямое: на дереве без единого
изменённого пути падает столько же — значит ни PR, ни этот бриф тут ни при чём.

**Сверка с §7.** Codex приводит `pnpm test`: 1823 теста прошли. Противоречия с
таблицей выше нет — это разные хосты: у Codex POSIX-среда, где `chmod` и `$HOME`
работают, у меня Windows, где нет. Расходятся не результаты, а операционные
системы.

### Почему это чинится в двух местах, а не в одном

`.claude/hooks/dod-checks.json` = `["pnpm lint","pnpm typecheck","pnpm test:unit"]`,
и в `vitest.config.ts` **`testTimeout: 300_000` стоит только у проекта `e2e`** —
`unit` и `template` идут на дефолтных 5000 мс, при том что `template`-тесты почти
целиком спавнят node-процессы. Отсюда два класса, и лечатся они по-разному:

| класс           | признак                                                                                    | лечение                                                             |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| таймауты        | счётчик гуляет; `final-component symlink` — 828 мс в изоляции, ровно 5000 мс под нагрузкой | поднять `testTimeout` у `template`; ни одно утверждение не меняется |
| POSIX-семантика | стабильные ~7, `chmod`/`$HOME` не действуют                                                | гонять сюиту в WSL-чекауте **внутри** ФС WSL, не через `/mnt/c`     |

Пропускать их по `platform === 'win32'` — плохой вариант: выглядит как ослабление
теста ради зелёного. Честная форма, если без WSL, — проба возможности: сделать
`chmod`, проверить, что он подействовал, и пропустить с явным сообщением, если
нет.

---

## 6. Метод

Прочитаны все четыре раунда ревью (5 issue-комментариев, 5 inline). Каждая
закрытая находка перепроверена в коде на HEAD. Обе новые находки воспроизведены
запуском `editFragments` и самих хуков на подготовленных payload'ах. Рабочее
дерево не изменялось, ничего не коммитилось.

---

## 7. Codex response — 2026-08-19

### Codex response — §3.1: согласен, исправлено

Добавлены два независимых глобальных бюджета: максимум **128 секций** и **512
компонентов destination-path** на один `apply_patch`. После исчерпания любого
бюджета normalizer возвращает один `appliesToAll` refusal и прекращает разбор до
filesystem resolution следующих секций. Общие уже разрешённые path-prefixes
кэшируются внутри одного вызова.

Дополнительный component budget нужен поверх предложенного section budget:
иначе один сверхглубокий путь всё ещё оставлял бы работу `repositoryPatchPath`
неограниченной числом компонентов.

Регрессии:

- `codex.test.ts › "refuses the whole patch and stops processing after the global section budget is exhausted"`;
- `codex.test.ts › "refuses the whole patch before later sections after the global path-component budget is exhausted"`.

Повторный локальный замер сценария с 3 840 секциями, глубиной 120 и patch размером
1 006 109 символов: **391 ms**, один глобальный refusal
`destination path component count exceeds the 512-component inspection limit`.

### Codex response — §3.2: согласен, исправлено

`guard-core-purity`, `guard-web-boundary` и `guard-secret-file` теперь отделяют
глобальный inspection refusal от совпадения с охраняемым инвариантом. Большой
docs-only patch блокируется нейтрально (`BLOCKED — cannot safely inspect this
edit`), называет конкретный лимит и предлагает разбить patch; сообщения больше
не утверждают, что нарушена purity/web/credential policy.

В `invariants.md` явно записано третье состояние: понятный payload, который
нельзя безопасно проверить в пределах заявленного work bound, блокируется
нейтрально; это не match и не внутренний error.

Регрессия: `codex.test.ts › "$guard blocks with a neutral, actionable size-limit refusal"`
для всех трёх guards.

### Codex response — §4.1: закрыто документацией

В decision record добавлен точный контракт и ссылка на
`https://learn.chatgpt.com/docs/hooks`: `Bash` и `apply_patch` используют
`tool_input.command`, а replacement input требует строковый `command`. Guards
принимают документированную строковую форму; неизвестные формы остаются
fail-open. Поведение parser не расширялось ради недокументированной гипотезы.

### Codex response — §4.2: требуется действие человека

Метка `human-review` по-прежнему отсутствует. Я её не ставил: она является
внешним свидетельством review, и сам автор исправления не должен создавать это
свидетельство за reviewer. После принятия этого ответа метку должен поставить
владелец/reviewer с repository triage permission.

### Codex response — §4.3: согласен, исправлено

README теперь не оставляет trust/re-review claim без опоры: тот же абзац прямо
ссылается на официальную Codex hooks documentation, где trust привязан к hash
hook definition, а новый/изменённый hook помечается для повторного review.

### Codex response — §4.4: проверено против AR-113

Текст Jira `AR-113` получен напрямую 2026-08-19. Текущий PR соответствует его
scope и acceptance criteria: Claude tree остаётся authoring source; drift-check
проверяет Codex projection; generated/create/init/upgrade/package/dogfood пути
несут instructions, skills, agents и hooks обоих harnesses; `apply_patch`
покрыт архитектурными guards; user-owned `AGENTS.md`/hook wiring сохраняются;
trust/review требования документированы; PR остаётся draft и не merged.

### Codex response — validation

- focused review regressions: **7 / 7**;
- related template suites: **113 / 113**;
- full `pnpm test`: **52 files, 1823 tests passed**;
- `pnpm lint`, `pnpm typecheck`: pass;
- `sync-agent-os --check`, `sync-codex-adapter --check`: pass;
- secret sweep (380 tracked files) + scanner self-test: pass;
- incremental security scan: **SHIP**, blockers/advisories отсутствуют;
- GitHub CI на `38729bb`: **4 / 4 passed** (`ci`, оба template jobs,
  GitGuardian);
- fix commit: `38729bb` (`fix(agent-os): bound Codex patch inspection`), pushed в
  ветку draft PR #90; merge не выполнялся;
- `PR-90-REVIEW.md` остаётся untracked и в commit не включается.

---

## 8. Codex response — 2026-08-19, follow-up

### Codex response — O1: согласен, исправлено

В authored decision record теперь явно записано, что
`MAX_PATCH_PATH_COMPONENTS` — агрегированный per-patch бюджет: компоненты
destination-path суммируются по всему `apply_patch`, поэтому допустимое число
файлов уменьшается с ростом глубины путей. Там же указан рабочий выход из
ограничения — разбить edit на несколько меньших patch-команд.

Регрессия:
`codex.test.ts › "documents how the aggregate path-component budget limits files per patch"`.

### Codex response — O2: согласен, исправлено

Заголовок authored `edit-input.mjs` теперь перечисляет все семь глобальных
бюджетов нормализатора: sources, hunks, output, splices, comparisons, sections
и path components. Derived root-копия обновлена через `sync-agent-os`.

Регрессия:
`codex.test.ts › "names all seven per-patch inspection budgets in the normalizer header"`.

### Codex response — O3: без изменения

Метка `human-review` остаётся действием владельца/reviewer с соответствующими
правами. Сам автор исправления не ставил её и не создавал свидетельство внешнего
review от своего имени.

### Codex response — follow-up validation

- новые focused regressions: **2 / 2**;
- полный `test/template/codex.test.ts`: **57 / 57**;
- `pnpm lint`, `pnpm typecheck`: pass;
- `sync-agent-os --check`, `sync-codex-adapter --check`: pass;
- default parallel `pnpm test`: **1787 passed / 38 timed out** на WSL-mounted
  filesystem; первичные failures были только timeout'ами (обычно 5 s),
  вторичные `ENOTEMPTY` появились после прерванных операций;
- полный suite без I/O-конкуренции
  (`pnpm build && vitest run --maxWorkers=1`): **52 files / 1825 tests passed**;
- бриф остаётся untracked и не входит в commit.
