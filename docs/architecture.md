# Архитектура Rolay Server

## 1. Цели

`Rolay` нужен для небольшой академической группы, которой важны:

- совместное редактирование `.md` в реальном времени;
- корректная работа при временном офлайне;
- синхронизация дерева файлов без тихой потери изменений;
- простая self-hosted эксплуатация;
- понятный протокол, который можно реализовать в Obsidian plugin без привязки к текущему чату.

## 2. Продуктовые ограничения `v1`

В `v1` сознательно сужаем объём:

- real-time только для Markdown-файлов;
- сервер является источником истины для дерева файлов;
- вложения и прочие не-Markdown файлы передаются как blob-объекты;
- один workspace примерно соответствует одной учебной группе;
- роли только базовые: `owner`, `editor`, `viewer`.

Это намеренно проще, чем у Relay. Нам важнее надёжный и понятный фундамент, чем максимальное покрытие кейсов.

## 3. Главная архитектурная идея

Система делится на три разных режима данных:

1. `Workspace tree`
   - канонический серверный индекс файлов и папок;
   - хранит пути, типы файлов, ревизии, состояние удаления, привязку к CRDT-документу или blob;
   - не является CRDT.

2. `Markdown document content`
   - хранится как Yjs-документ;
   - синхронизируется через WebSocket в real time;
   - обеспечивает merge без текстовых конфликтов при конкурентном редактировании.

3. `Blob content`
   - для изображений, PDF, архивов и любых других бинарных файлов;
   - хранится по `SHA-256` в S3-compatible storage;
   - связывается с записью файла в файловом дереве через версию и hash.

Идея в том, что CRDT используется там, где он реально нужен: в содержимом заметки. Путь файла, rename, delete, attach и quota проще и безопаснее решать через обычную серверную модель данных.

## 4. Технологическая стратегия

Для `v1` рекомендуемый стек:

- `TypeScript` / `Node.js`;
- `Fastify` или `NestJS` для HTTP API;
- `Hocuspocus` или совместимый Yjs websocket layer для CRDT;
- `PostgreSQL` для основной модели данных;
- `Redis` опционально для presence, rate limit и горизонтального масштабирования;
- `S3-compatible storage` для blob-объектов;
- Docker-based deploy.

Почему не форк `relay-server`:

- у Relay open-source не покрывает весь control plane;
- для нашей задачи важно быстро и понятно реализовать auth, workspace-модель и file tree;
- TypeScript упростит одновременную разработку сервера и плагина.

## 5. Логические модули сервера

### 5.1 Auth Module

Отвечает за:

- регистрацию и вход;
- refresh/access token flow;
- приглашения в workspace;
- device sessions;
- выдачу краткоживущих realtime/blob токенов.

### 5.2 Workspace Module

Отвечает за:

- создание workspace;
- membership и роли;
- workspace settings;
- выдачу snapshot дерева файлов.

### 5.3 Tree Module

Отвечает за:

- создание папок и файлов;
- rename, move, delete, restore;
- хранение метаданных по файлам;
- optimistic concurrency для file operations;
- публикацию событий об изменении дерева.

### 5.4 CRDT Module

Отвечает за:

- выдачу токенов для realtime-документов;
- загрузку и сохранение Yjs state;
- WebSocket-сессию для `.md`;
- awareness/presence в пределах открытого документа.

### 5.5 Blob Module

Отвечает за:

- upload/download tickets;
- валидацию `SHA-256`, размера и MIME;
- привязку blob к ревизии файла;
- дедупликацию по хэшу.

### 5.6 Sync/Event Module

Отвечает за:

- SSE stream или аналогичный однонаправленный канал событий workspace;
- доставку событий об изменениях дерева;
- курсор событий для резюма после реконнекта.

## 6. Модель данных

Ниже не финальная схема SQL, а целевая предметная модель.

### 6.1 Users

- `id`
- `username`
- `display_name`
- `password_hash`
- `created_at`
- `disabled_at`

### 6.2 Devices

- `id`
- `user_id`
- `device_name`
- `last_seen_at`
- `refresh_token_hash`

### 6.3 Workspaces

- `id`
- `slug`
- `name`
- `created_by`
- `created_at`

### 6.4 WorkspaceMembers

- `workspace_id`
- `user_id`
- `role` = `owner | editor | viewer`
- `joined_at`

### 6.5 WorkspaceInvites

- `id`
- `workspace_id`
- `code`
- `role`
- `expires_at`
- `max_uses`
- `used_count`

### 6.6 FileEntries

- `id`
- `workspace_id`
- `path`
- `kind` = `folder | markdown | binary`
- `content_mode` = `none | crdt | blob`
- `doc_id` nullable
- `current_blob_hash` nullable
- `mime_type` nullable
- `size_bytes` nullable
- `entry_version`
- `deleted_at` nullable
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

### 6.7 DocumentStates

- `doc_id`
- `workspace_id`
- `file_entry_id`
- `storage_key`
- `state_vector` nullable
- `updated_at`

### 6.8 BlobObjects

- `hash`
- `storage_key`
- `size_bytes`
- `mime_type`
- `created_at`

### 6.9 TreeEvents

- `seq`
- `workspace_id`
- `event_type`
- `op_id`
- `actor_user_id`
- `actor_device_id`
- `payload_json`
- `created_at`

## 7. Канонические правила `v1`

### 7.1 Источник истины

- содержимое `.md` файла: Yjs document;
- путь файла и факт его существования: server-side `FileEntries`;
- бинарное содержимое: `BlobObjects`.

### 7.2 File identity

Файл не идентифицируется только путём.

Каждый файл имеет стабильный `file_entry_id`. Это позволяет:

- безопасно делать rename/move;
- отделять identity файла от его текущего пути;
- удобнее обрабатывать offline operations.

### 7.3 Rename и move

`rename` и `move` меняют `path`, но не меняют `file_entry_id`.

### 7.4 Delete

Delete сначала логический:

- запись получает `deleted_at`;
- события продолжают ссылаться на тот же `file_entry_id`;
- физическая уборка blob/CRDT state возможна отдельным background job позже.

## 8. Сценарии синхронизации

### 8.1 Открытие workspace

1. Клиент проходит auth.
2. Клиент запрашивает snapshot дерева файлов.
3. Клиент открывает event stream по workspace.
4. Клиент сверяет локальные offline-операции с серверным снапшотом.

### 8.2 Открытие Markdown-файла

1. Клиент запрашивает `crdt-token` для `file_entry_id`.
2. Сервер возвращает `doc_id`, `ws_url`, `token`.
3. Клиент подключается к Yjs/Hocuspocus endpoint.
4. После sync клиент отражает текущее содержимое в локальном vault.

### 8.3 Upload бинарного файла

1. Клиент вычисляет `SHA-256`.
2. Клиент запрашивает upload ticket.
3. Если blob уже есть, сервер может пропустить upload.
4. После успешного upload клиент делает `commit blob revision`.
5. Сервер обновляет `FileEntries` и публикует tree event.

### 8.4 Работа в офлайне

Для `.md`:

- локальные изменения продолжают копиться в Yjs persistence;
- после реконнекта Yjs сам сливает состояние.

Для дерева файлов:

- операции кладутся в локальную очередь;
- при онлайне операции отправляются в сервер в порядке создания;
- каждая операция содержит precondition.

## 9. Почему tree не CRDT

Папки и пути формально тоже можно моделировать CRDT-структурами, но для `v1` это плохой tradeoff:

- сложнее документировать;
- сложнее объяснить rename/delete semantics;
- сложнее отлаживать в Obsidian file system;
- намного выше риск редких, но болезненных кейсов.

Для небольшой группы server-authoritative tree даёт лучший баланс простоты и предсказуемости.

## 10. Безопасность

Минимальный baseline:

- `access token` короткий;
- `refresh token` хранится отдельно по device session;
- отдельные краткоживущие токены для CRDT websocket;
- отдельные upload/download tickets для blob;
- проверка роли workspace на каждом mutation endpoint;
- audit trail через `TreeEvents`.

## 11. Что откладываем

После `v1` можно вернуть в план:

- `.canvas` как отдельный CRDT-тип;
- shared cursors на уровне workspace;
- granular permissions по папкам;
- server-side text indexing и full-text search;
- WebDAV-like bridge;
- partial sync для больших workspace.
