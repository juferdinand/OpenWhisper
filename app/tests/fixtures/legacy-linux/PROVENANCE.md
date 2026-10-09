# Frozen legacy Linux test inputs

These files are test fixtures retained for optional checks of the public Linux 0.2.5 updater and
owned desktop behavior. They are not application or packaging dependencies.

`tauri.conf.json` is copied from immutable public commit
`d69b43bf6e7017c61089e117e79af34f57f297c4`, path `linux/src-tauri/tauri.conf.json`, SHA-256
`2d901a9a06e9844697fab1ef3da0f2d44315254d3ab5bf9045066b9bdc743731`. The optional Linux updater
oracle tests assert this hash before passing the config to the supplied oracle. They retain their
explicit asset/oracle environment gates and original 0.2.5 archive and signature hashes.

`run-owned-desktop.py` and `test-owned-portals.py` are byte-identical copies of the current
legacy source snapshot at commit `47560a29b85b41630b116ceaa5002d39de2b9d2b`, respectively
`linux/scripts/run-owned-desktop.py` (SHA-256
`ec4893b2190753e83f7ab85eae76bc90fb51c6e9589de24e78a5a4fefbcd0a13`) and
`linux/scripts/test-owned-portals.py` (SHA-256
`af17a2dedbaece0ccf6ee2b06fdb0ba3701b8f9ddc03a37c5a96843ae69efdb6`). These hashes are checked
by the owned Dev recording runner before either helper is copied into its private payload.
