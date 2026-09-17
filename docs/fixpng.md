# /fixpng

Plan: port the reference metadata converter, add a bounded owner-only command,
then validate chunk integrity, unchanged pixel data, profile identity and download limits.

Accept one PNG upload or one message link containing exactly one PNG attachment.
Only the configured server and invoking channel are allowed for message links.
Message Content restrictions still apply to linked attachments.

Limits: 50 MiB input, 30-second download timeout, one conversion/download at a time
per process, no waiting queue. Only Discord attachment CDN URLs; no redirects.
Declared size is checked before downloading; actual streamed bytes are capped too.
No image decompression, pixel allocation, LLM calls or disk files. Output is private.

Requires RGB/RGBA PNG with cICP 9/16/0/1 (BT.2020 primaries, PQ transfer,
RGB matrix, full range). Removes cICP and old iCCP chunks, inserts the exact
reference Rec2100PQ ICC. Other chunks, including compressed pixels, stay unchanged.
This changes metadata, not pixel values, tone mapping, or transfer encoding.