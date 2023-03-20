#!/bin/bash
OUTPUT="output/MarianaTekToGCal.js"

function add_file {
  cat "$1" >> "$OUTPUT";
  echo >> "$OUTPUT";
}

echo -n '' > "$OUTPUT"
add_file "src/config.js"
add_file "src/main.js"
add_file "src/util.js"
add_file "src/Diagnostics.js"
add_file "src/MarianaTekFetcher.js"
