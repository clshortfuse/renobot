# User message lookup

First checkpoint: implement and validate `/findmessages userid:… channel:… limit:…`.
Deletion is deferred until a separate preview/confirmation workflow is implemented.

Owner-only, configured server only. Defaults to scanning the newest 1,000 messages,
with a maximum of 5,000 per invocation. Returns an ephemeral count and text attachment
of message links. Does not read message text for matching, use an LLM, or delete messages.
The user ID works for banned users without looking up their current membership.

Requires View Channel and Read Message History. Select a public forum post/thread
directly to scan it; choosing a parent text channel does not scan its threads.
Results are partial when the scan limit is reached. No full-server search is performed.
Private threads are excluded. Registration and a runtime reload are needed to go live.