Use this context for the server-side continuation of Rolay Excalidraw integration.

We did a client-side technical discovery against the installed Obsidian Excalidraw plugin `2.20.3` and the official Excalidraw Automate docs.

Confirmed client capabilities:

- We can reliably discover open Excalidraw views via Obsidian `workspace.getLeavesOfType("excalidraw")`.
- Excalidraw Automate exposes:
  - `setView(view | "first" | "active")`
  - `getExcalidrawAPI()`
  - `getViewElements()`
  - `setViewModeEnabled(enabled)`
  - `viewUpdateScene(scene, restore?)`
  - `onFileOpenHook`
  - `onViewUnloadHook`
  - `onViewModeChangeHook`
- The installed Excalidraw view internally uses:
  - `onChange`
  - `onPointerUpdate`
  - `view.excalidrawAPI.getSceneElements()`
  - `view.excalidrawAPI.getSceneElementsIncludingDeleted()`
  - `view.excalidrawAPI.getAppState()`
  - `view.updateScene(...)`
  - `view.synchronizeWithData(...)`
- Viewer/read-only mode with pan/zoom looks realistic through `viewModeEnabled`, `allowPinchZoom`, and `allowWheelZoom`.

Important limitation:

- There is no confirmed documented public hook for another plugin to subscribe to scene changes or pointer updates.
- Scene apply is realistic and fairly supported.
- Scene capture and cursor capture probably require wrapping internal Excalidraw view callbacks such as `onChange` and `onPointerUpdate`, or DOM interception.
- That makes the ambitious live integration possible, but fragile.

Recommended product direction:

- Treat `single-editor live broadcast` as the ambitious mode.
- Keep file/autosave refresh as the reliable fallback.

If we proceed with the ambitious mode, the server contract should be designed around a single current editor, not multi-writer CRDT.

Recommended server responsibilities:

1. editor lease / ownership for a drawing
   - acquire editor
   - release editor
   - heartbeat / expiry
   - current editor info in room state

2. live scene broadcast channel
   - one active editor publishes scene updates
   - viewers subscribe
   - no assumption of multi-writer merge

3. live cursor / pointer broadcast
   - only for the current editor
   - scene-space coordinates preferred, not viewport-space

4. control transfer UX support
   - request control
   - grant / deny / steal control if policy allows

5. reconnect semantics
   - viewers can request latest full scene snapshot
   - then continue with incremental live updates if needed

The client is likely to prefer this protocol shape:

- initial full scene snapshot
- then editor-only live scene messages
- separate editor cursor presence
- separate editor lease state

Do not design a multi-user concurrent-editing protocol for Excalidraw yet unless the client side later proves that stable scene-delta capture and loop-free multi-writer apply are realistic with the installed plugin.
