#!/bin/bash

./build-and-push.sh
while inotifywait -r src -e create,delete,modify --exclude '/\.'; do {
  ./build-and-push.sh
}; done
