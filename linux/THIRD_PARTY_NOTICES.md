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
