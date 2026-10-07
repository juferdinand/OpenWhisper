# Third-party notices

## whisper.cpp, Parakeet, and ggml

Source: https://github.com/ggml-org/whisper.cpp

Pinned revision: 927cfce34f31707e17f2bff35c349632fb9e2c3a (b5130).

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Other dependencies

Rust dependencies are recorded in `Cargo.lock`. Shared UI JavaScript dependencies are recorded
in `../shared/ui/package-lock.json`; Linux CLI tooling is recorded in `package-lock.json`.
Each dependency retains its upstream license. Linux system libraries are provided by
the distribution or package. Speech models are downloaded separately and retain their
upstream licenses; see the repositories in shared/models.json.

## GTK Layer Shell

Source: https://github.com/wmww/gtk-layer-shell

The optional Wayland overlay uses GTK Layer Shell through runtime loading. Debian packages
use the distribution's library. AppImages explicitly include the build system's native
`libgtk-layer-shell.so.0` and retain its installed Debian copyright file, or the matching
upstream 0.10.1 source notice snapshot when an Arch package has no separate copyright file.
The Arch snapshot retains the bundled protocol notices and adds the installed
`wayland-protocols` copyright blocks for external protocols, with their package versions
and input hashes. These notice inputs do not identify the distribution binary's historical
build dependency versions.
The library as a whole is LGPL-3.0-or-later; most individual files use MIT. Its full LGPL,
GPL and MIT texts and component copyright notices are retained in
`usr/share/doc/gtk-layer-shell/` inside the AppImage, alongside build-origin version/hashes.
The upstream source reference and notice snapshot are also in `licenses/gtk-layer-shell/`.
These library terms do not replace OpenWhisper's own MIT license. The library remains
separate and dynamically loaded; unsupported compositors retain the main recording control.

## Inter 4.1

Source: https://github.com/rsms/inter/tree/v4.1

The unmodified Inter Variable font is bundled in ../shared/ui/public/fonts/InterVariable.woff2.
Its full SIL Open Font License is included in ../shared/ui/public/fonts/LICENSE.txt.

## Vulkan and SPIR-V headers

Vulkan builds use pinned Khronos Vulkan-Headers and SPIRV-Headers from
https://github.com/KhronosGroup/Vulkan-Headers and https://github.com/KhronosGroup/SPIRV-Headers.
The exact revisions and checksums are in native/vulkan-headers.json. Upstream MIT, Apache-2.0,
and CC-BY-4.0 notices are included in licenses/ and packaged with the app. The distribution's
Vulkan loader and graphics driver retain their own licenses; no proprietary GPU driver is bundled.

## Wayland and keyboard metadata

The compositor metadata guard uses `wayland-client` 0.31.15, `wayland-backend` 0.3.17,
`wayland-scanner` 0.31.11, and `wayland-sys` 0.31.11 from
[Wayland Rust bindings](https://github.com/Smithay/wayland-rs), including the generated core
Wayland protocol definitions; `xkbcommon` 0.9.0 from
[xkbcommon Rust bindings](https://github.com/rust-x-bindings/xkbcommon-rs); and `rustix` 1.1.5
from [rustix](https://github.com/bytecodealliance/rustix). Its added transitive dependencies
include `downcast-rs` 1.2.1, `xkeysym` 0.2.1, and the build-time `quick-xml` 0.41.0.
These components are used under their MIT license option. Their upstream copyright notices,
permission/disclaimer text, and exact source references are preserved in
the full text below, included in this packaged notices file.

`libxkbcommon` is dynamically linked. Debian packages use the distribution's library and
notices; AppImage bundles retain its distribution copyright file at
`usr/share/doc/libxkbcommon0/copyright` inside the image. The library's MIT/X11-derived
licenses are documented in its [upstream license](https://github.com/xkbcommon/libxkbcommon/blob/xkbcommon-1.4.0/LICENSE).

```text
Wayland Rust bindings: wayland-client0.31.15/backend0.3.17/scanner0.31.11/sys0.31.11
Source: https://github.com/Smithay/wayland-rs/blob/05196740da57e41b60a9e9f8e35079e9bd29b89a/LICENSE.txt

Copyright (c) 2015 Elinor Berger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

xkbcommon Rust bindings0.9.0
Source: https://github.com/rust-x-bindings/xkbcommon-rs/blob/cfe39aa0d2bdb9a22f33b72a9cd66a40b41180aa/LICENSE

Copyright (c) 2016 Remi Thebault <remi.thebault@gmail.com>

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

rustix1.1.5 copyright statement
Source: https://github.com/bytecodealliance/rustix/blob/287214b889865d8e1406a0ee71cc409b6f6191c8/COPYRIGHT

Short version for non-lawyers:

`rustix` is triple-licensed under Apache 2.0 with the LLVM Exception,
Apache 2.0, and MIT terms.


Longer version:

Copyrights in the `rustix` project are retained by their contributors.
No copyright assignment is required to contribute to the `rustix`
project.

Some files include code derived from Rust's `libstd`; see the comments in
the code for details.

Except as otherwise noted (below and/or in individual files), `rustix`
is licensed under:

 - the Apache License, Version 2.0, with the LLVM Exception
   <LICENSE-Apache-2.0_WITH_LLVM-exception> or
   <http://llvm.org/foundation/relicensing/LICENSE.txt>
 - the Apache License, Version 2.0
   <LICENSE-APACHE> or
   <http://www.apache.org/licenses/LICENSE-2.0>,
 - or the MIT license
   <LICENSE-MIT> or
   <http://opensource.org/licenses/MIT>,

at your option.

rustix1.1.5 MIT selection
Source: https://github.com/bytecodealliance/rustix/blob/287214b889865d8e1406a0ee71cc409b6f6191c8/LICENSE-MIT

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

downcast-rs1.2.1 MIT selection
Source: https://github.com/marcianx/downcast-rs/blob/c4c48bad50482df2544115ba971acfd5916e6140/LICENSE-MIT

Copyright (c) 2020 Ashish Myles and contributors

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

xkeysym0.2.1 MIT selection
Source: https://github.com/notgull/xkeysym/blob/77596eb8319f8d7a97db6477f307a94a0905c439/LICENSE-MIT

Copyright (c) 2022-2023 John Nunley

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

quick-xml0.41.0 (build-time scanner dependency)
Source: https://github.com/tafia/quick-xml/blob/4deda08abeffdc188c269360229cf47e12a77a9f/LICENSE-MIT.md

The MIT License (MIT)

Copyright (c) 2016 Johann Tuffe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:


The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.


THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

Wayland core protocol metadata generated from wayland-client0.31.15/wayland.xml
Source: https://github.com/Smithay/wayland-rs/blob/05196740da57e41b60a9e9f8e35079e9bd29b89a/wayland-client/wayland.xml

Copyright © 2008-2011 Kristian Høgsberg
Copyright © 2010-2011 Intel Corporation
Copyright © 2012-2013 Collabora, Ltd.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice (including the
next paragraph) shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT.  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
