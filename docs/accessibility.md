# Accessibility guidance for editor controls

The engine has no user interface of its own. Your app renders the toolbar, dialogs and status text. These notes show how to wire the engine's state into controls that work for keyboard and screen reader users.

## Undo and redo buttons

```tsx
<button onClick={() => engine.undo()} disabled={!state.canUndo} aria-keyshortcuts="Control+Z Meta+Z">
  Undo{state.undoLabel ? <span className="visually-hidden">: {state.undoLabel}</span> : null}
</button>
```

- Use real `<button>` elements, so they get focus and keyboard activation for free.
- Include the step label, such as "Undo: Move rect", in the accessible name. Use visible text or visually hidden text, not only a `title`, because screen readers do not reliably read `title`.
- `bindKeyboardShortcuts` leaves inputs, text areas, contenteditable areas and Fabric text editing alone. Keyboard users keep native text undo there.
- Announce the shortcuts with `aria-keyshortcuts`, and list them in your help screen.

## Save status

Announce save changes politely. Do not steal focus:

```tsx
<p aria-live="polite" aria-atomic="true">
  {state.saveStatus === 'saving' && 'Saving…'}
  {state.saveStatus === 'saved' && 'All changes saved'}
  {state.saveStatus === 'unsaved' && 'Unsaved changes'}
  {state.saveStatus === 'error' && 'Could not save. Retrying.'}
  {state.saveStatus === 'conflict' && 'Someone else changed this document.'}
</p>
```

- Keep the live region in the page all the time, and change only its text. A region inserted at the moment of the change is often not announced.
- Autosave changes the status often. Announce the settled states, `saved`, `error` and `conflict`, rather than every `saving` flash, if users find it noisy.

## Errors that need a decision

Conflicts (`SAVE_CONFLICT`), recovery offers and missing assets (`MISSING_ASSETS`) need the user to choose. Show them in a dialog:

- Use `<dialog>`, or `role="alertdialog"` with a labelled title.
- Move focus into the dialog when it opens, and back to the control that opened it when it closes.
- Give each choice a clear name, such as "Keep my version" and "Load the saved version", rather than "OK" and "Cancel".
- Name the problem in words. For missing images, list the file names from `error.missingAssets`.

## Export

- Run `engine.preflightExport({ format })` when the export menu opens. Disable formats that would fail, and explain why next to them.
- When an export succeeds, announce it in the live region, for example "Exported drawing.png, 1600 by 1000 pixels".

## The canvas itself

A Fabric canvas is a bitmap, so screen readers cannot see its objects.

- Give the canvas an accessible name: `<canvas aria-label="Floor plan editor">`.
- Offer a text alternative for important content, such as a list of objects built from `engine.toDocument().objects` with their names from your metadata.
- Offer keyboard ways to move and resize the selected object, such as arrow keys with `engine.transaction('Move', ...)`, so pointer-only interaction is not the only option.

## Motion and timing

- Autosave and recovery run in the background and never need a timed response.
- Avoid auto-dismissing error messages. `SAVE_FAILED` stays until the next successful save.
