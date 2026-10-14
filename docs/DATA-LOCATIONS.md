# Data locations

OpenWhisper keeps its data on the user's computer under product-named folders. The package
identity `io.github.whisperfree` and the macOS defaults domain are unchanged.

| Platform | Settings, history, recovery | Models, downloads, transcripts | Cache, session, logs |
| --- | --- | --- | --- |
| macOS | `~/Library/Application Support/OpenWhisper/Config` | `~/Library/Application Support/OpenWhisper/Data` | `~/Library/Caches/OpenWhisper` |
| Linux | `$XDG_CONFIG_HOME/openwhisper` (`~/.config/openwhisper`) | `$XDG_DATA_HOME/openwhisper` (`~/.local/share/openwhisper`) | `$XDG_CACHE_HOME/openwhisper` (`~/.cache/openwhisper`) |

The optional recording history is stored in `history/entries.json` and holds up to 20 new
recordings with their text, date and duration when available. Older `history.json` files are left
untouched and are not loaded into the current history list.

The legacy 0.2.x macOS preferences stay in `~/Library/Preferences/io.github.whisperfree.plist`.
The Dev profile keeps its separate `io.github.whisperfree.dev` folders.

## Relocation from earlier versions

Up to version 0.4.2 the stable profile used `whisperfree` folders on Linux and, on macOS,
`Application Support/io.github.whisperfree`, `Application Support/WhisperFree` and
`Caches/io.github.whisperfree`. On the first start of a newer version each existing earlier
root is moved once to its new location before the profile is opened
(`app/src/services/settings/stable-storage-relocation.ts`):

- Each root moves with one same-volume rename, so it is either entirely at the old or entirely
  at the new location. Nothing is copied, merged or deleted.
- Legacy 0.2.x sources (snippets, models, `Diktate`/`Transcripts`) move with the former
  `WhisperFree` folder, so the 0.2.x import still finds them under the Data root.
- If a new root already exists, the earlier root is left untouched and startup logs
  `code=PREVIOUS_STORAGE_KEPT`.
- Earlier roots that are symlinks, not owned by the user or writable by other users are refused
  with `UNSAFE_SOURCE`. A settings or data root that cannot be renamed, for example across
  volumes, stops startup with `RELOCATION_FAILED` instead of starting with empty data. A cache
  that cannot be moved is left in place and a new cache is used (`code=CACHE_NOT_RELOCATED`).
