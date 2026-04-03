# Протокол Rolay `v1`

Документ описывает внешний контракт между Obsidian plugin и сервером.

`v1` использует три транспорта:

- `REST JSON` для auth, tree и blob-мутаторов;
- `SSE` для событий workspace;
- `Yjs-compatible WebSocket` для real-time содержимого Markdown-документа.

## 1. Базовые принципы

- все времена в `UTC ISO-8601`;
- все идентификаторы строковые `UUIDv7` или совместимый формат;
- все mutation-запросы содержат `opId` для идемпотентности;
- file tree синхронизируется через snapshot + event stream;
- `.md` синхронизируется отдельно через CRDT-соединение.

## 2. Auth flow

`v1` uses opaque bearer tokens. They are short-lived access tokens plus longer-lived refresh tokens.

### 2.1 Login

`POST /v1/auth/login`

Request:

```json
{
  "username": "roma",
  "password": "secret",
  "deviceName": "Obsidian Desktop"
}
```

Response:

```json
{
  "accessToken": "opaque-access-token",
  "refreshToken": "opaque-refresh-token",
  "user": {
    "id": "usr_01",
    "username": "roma",
    "displayName": "Roma"
  }
}
```

### 2.2 Refresh

`POST /v1/auth/refresh`

Request:

```json
{
  "refreshToken": "opaque-refresh-token"
}
```

Response:

```json
{
  "accessToken": "new-opaque-access-token",
  "refreshToken": "new-opaque-refresh-token"
}
```

## 3. Workspace membership

### 3.1 Create workspace

`POST /v1/workspaces`

### 3.2 Create invite

`POST /v1/workspaces/{workspaceId}/invites`

### 3.3 Accept invite

`POST /v1/invites/accept`

## 4. Tree snapshot

### 4.1 Get current workspace tree

`GET /v1/workspaces/{workspaceId}/tree`

Response:

```json
{
  "workspace": {
    "id": "ws_01",
    "name": "Math Group"
  },
  "cursor": 184,
  "entries": [
    {
      "id": "fil_01",
      "path": "Algebra/Week-01.md",
      "kind": "markdown",
      "contentMode": "crdt",
      "entryVersion": 6,
      "docId": "doc_01",
      "deleted": false,
      "updatedAt": "2026-04-03T00:00:00Z"
    },
    {
      "id": "fil_02",
      "path": "Algebra/figures/plot.png",
      "kind": "binary",
      "contentMode": "blob",
      "entryVersion": 2,
      "blob": {
        "hash": "sha256:...",
        "sizeBytes": 48213,
        "mimeType": "image/png"
      },
      "deleted": false,
      "updatedAt": "2026-04-03T00:00:00Z"
    }
  ]
}
```

Клиент использует `cursor` как точку старта для event stream.

## 5. Tree mutations

Все tree-операции идут через server-authoritative API.

### 5.1 Batch endpoint

`POST /v1/workspaces/{workspaceId}/ops/batch`

Request:

```json
{
  "deviceId": "dev_01",
  "operations": [
    {
      "opId": "op_001",
      "type": "create_folder",
      "path": "Algebra"
    },
    {
      "opId": "op_002",
      "type": "create_markdown",
      "path": "Algebra/Week-01.md"
    }
  ]
}
```

Response:

```json
{
  "results": [
    {
      "opId": "op_001",
      "status": "applied",
      "eventSeq": 185
    },
    {
      "opId": "op_002",
      "status": "applied",
      "eventSeq": 186,
      "entry": {
        "id": "fil_01",
        "docId": "doc_01"
      }
    }
  ]
}
```

### 5.2 Supported operation types

- `create_folder`
- `create_markdown`
- `create_binary_placeholder`
- `rename_entry`
- `move_entry`
- `delete_entry`
- `restore_entry`
- `commit_blob_revision`

### 5.3 Preconditions

Операции, чувствительные к гонкам, должны содержать preconditions:

```json
{
  "opId": "op_003",
  "type": "rename_entry",
  "entryId": "fil_01",
  "newPath": "Algebra/Week-01-intro.md",
  "preconditions": {
    "entryVersion": 6,
    "path": "Algebra/Week-01.md"
  }
}
```

Если precondition не выполнен, сервер возвращает `409 Conflict`.

Response:

```json
{
  "results": [
    {
      "opId": "op_003",
      "status": "conflict",
      "reason": "entry_version_mismatch",
      "serverEntry": {
        "id": "fil_01",
        "path": "Algebra/Week-01-lecture.md",
        "entryVersion": 7
      }
    }
  ]
}
```

## 6. Event stream

### 6.1 Transport

`GET /v1/workspaces/{workspaceId}/events?cursor=184`

Ответ: `text/event-stream`

Каждое событие:

```text
id: 185
event: tree.entry.updated
data: {"entryId":"fil_01","path":"Algebra/Week-01.md","entryVersion":6}
```

### 6.2 Event types `v1`

- `tree.entry.created`
- `tree.entry.updated`
- `tree.entry.deleted`
- `tree.entry.restored`
- `blob.revision.committed`
- `workspace.member.joined`
- `workspace.member.left`

### 6.3 Event ordering

- порядок гарантирован в рамках одного workspace;
- `id` события монотонно возрастает;
- клиент может резюмировать поток по последнему полученному `id`.

## 7. CRDT document flow

### 7.1 Get CRDT token

`POST /v1/files/{entryId}/crdt-token`

Response:

```json
{
  "entryId": "fil_01",
  "docId": "doc_01",
  "provider": "yjs-hocuspocus",
  "wsUrl": "wss://rolay.example.com/v1/crdt",
  "token": "short-lived-doc-token",
  "expiresAt": "2026-04-03T12:00:00Z"
}
```

### 7.2 WebSocket semantics

`v1` использует стандартный Yjs-compatible protocol, а не свой бинарный формат.

Это значит:

- plugin может использовать существующий Yjs provider;
- сервер обязан поддерживать auth hook по `token`;
- `docId` передаётся по правилам выбранного Yjs transport layer.

### 7.3 Auth claims для doc token

Минимум:

- `workspaceId`
- `entryId`
- `docId`
- `role`
- `userId`
- `exp`

### 7.4 Persistence

Сервер обязан:

- загружать последнее Yjs state при открытии документа;
- периодически чекпоинтить состояние;
- не терять unsaved updates при кратковременном разрыве соединения.

## 8. Blob flow

### 8.1 Request upload ticket

`POST /v1/files/{entryId}/blob/upload-ticket`

Request:

```json
{
  "hash": "sha256:abc123",
  "sizeBytes": 48213,
  "mimeType": "image/png"
}
```

Response:

```json
{
  "alreadyExists": false,
  "upload": {
    "method": "PUT",
    "url": "https://storage.example.com/...",
    "headers": {
      "content-type": "image/png"
    }
  }
}
```

### 8.2 Commit blob revision

После загрузки клиент подтверждает новую ревизию файла через batch op:

```json
{
  "opId": "op_blob_01",
  "type": "commit_blob_revision",
  "entryId": "fil_02",
  "hash": "sha256:abc123",
  "sizeBytes": 48213,
  "mimeType": "image/png",
  "preconditions": {
    "entryVersion": 2
  }
}
```

### 8.3 Download ticket

`POST /v1/files/{entryId}/blob/download-ticket`

Response:

```json
{
  "hash": "sha256:abc123",
  "url": "https://storage.example.com/..."
}
```

## 9. Идемпотентность

Каждая mutation-операция обязана иметь `opId`.

Если клиент повторно отправляет тот же `opId`, сервер должен вернуть тот же логический результат, а не создать дубликат.

## 10. Ошибки API

Формат ошибок:

```json
{
  "error": {
    "code": "entry_version_mismatch",
    "message": "Entry version does not match server state",
    "details": {
      "entryId": "fil_01"
    }
  }
}
```

Базовые коды:

- `unauthorized`
- `forbidden`
- `workspace_not_found`
- `entry_not_found`
- `path_already_exists`
- `entry_version_mismatch`
- `invalid_operation`
- `blob_hash_mismatch`
- `payload_too_large`

## 11. Алгоритм клиента при старте

1. Выполнить login или refresh.
2. Запросить tree snapshot.
3. Открыть event stream от `cursor`.
4. Применить локальную очередь offline-операций.
5. Для открытых `.md` получить `crdt-token` и подключить Yjs provider.

## 12. Алгоритм клиента при реконнекте

1. Обновить `access token` при необходимости.
2. Переподнять event stream с последним `cursor`.
3. Для открытых документов запросить новые `crdt-token`.
4. Повторно отправить неподтверждённые `opId`, если нет подтверждения об их применении.
