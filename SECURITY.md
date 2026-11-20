# Security

Report a suspected vulnerability through the repository's private GitHub vulnerability reporting option when available. If it is unavailable, open an issue asking for a private contact channel without posting credentials, thread contents, or exploit details.

Cache Compact runs as a full-trust BB plugin on the BB server. It makes no external network requests and stores no API keys or credentials. It reads thread lifecycle metadata, token usage events, and advertised provider commands from the local BB SDK, persists scheduling metadata in its own plugin SQLite database, and invokes `threads.compact` or `threads.send("/compact")` only for eligible idle threads.
