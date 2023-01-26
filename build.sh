#!/bin/bash
OUTPUT="MarianaTekToGCal.js"

function add_file {
  cat "$1" >> "$OUTPUT";
}

echo -n '' > "$OUTPUT"
add_file "src/config.js"
add_file "src/main.js"
add_file "src/util.js"
