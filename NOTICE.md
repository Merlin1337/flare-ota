# Notices

flare-ota is a new implementation, inspired by two MIT-licensed projects. Thank you to both.

## focux/open-ota

https://github.com/focux/open-ota — the technical reference: Expo Updates protocol on Cloudflare
Workers, D1, R2 and Access, signed manifests, rollouts, GC.

Parts adapted from it, marked in the source:

- `packages/server/src/signing.ts`: PKCS#1 → PKCS#8 wrapping of the signing key.
- `packages/server/src/protocol.ts`: `parseFailedUpdateIds`, `rolloutBucket`, `multipartBody`.

```
MIT License

Copyright (c) 2026 Leonardo E. Dominguez

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
```

## dnlsilva/open-ota

https://github.com/dnlsilva/open-ota — product ideas: an MCP server sharing one tool contract
across remote and stdio transports, signed preview links with QR codes, adoption metrics,
pause/promote between channels. No code was copied; flare-ota implements these on top of the
standard `expo-updates` client instead of a custom native SDK.

## Plus Jakarta Sans

The dashboard embeds Plus Jakarta Sans (`packages/server/src/fonts.ts`), Copyright 2020 The Plus
Jakarta Sans Project Authors (https://github.com/tokotype/PlusJakartaSans), licensed under the
SIL Open Font License, Version 1.1 (https://openfontlicense.org).
