#!/bin/sh

# Escape a string so it can be safely embedded in a JSON double-quoted value.
# apt/npm/tunnel output contains quotes, backslashes, newlines and ANSI/control
# characters that would otherwise produce invalid JSON (the API rejects it with
# "Bad control character in string literal"). Collapse whitespace to spaces,
# drop any remaining control chars, then escape backslash and double-quote.
json_escape() {
    printf '%s' "$1" \
        | tr '\n\r\t' '   ' \
        | tr -d '\000-\037\177' \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

send_callback() {
    if [ -z "$CALLBACK_URL" ]; then
        return
    fi
    curl -s -X POST "$CALLBACK_URL" \
        -H "Content-Type: application/json" \
        -d "$1"
}

report_started() {
    # $1 = web (primary) tunnel URL.
    # The `started` event is normally emitted by tunnel.py; this shell helper mirrors its shape.
    send_callback "{\"event\":\"started\",\"webUrl\":\"$(json_escape "$1")\"}"
}

report_error() {
    send_callback "{\"event\":\"error\",\"message\":\"$(json_escape "$1")\"}"
}

send_log() {
    send_callback "{\"event\":\"log\",\"message\":\"$(json_escape "$1")\"}"
}
