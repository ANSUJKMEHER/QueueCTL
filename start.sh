#!/bin/bash

# Ensure data directory exists
mkdir -p data/ workers/

# Start the dashboard server in the background (binds to $PORT)
node bin/queuectl.js dashboard &

# Start 2 workers in the foreground so the container stays alive
node bin/queuectl.js worker start --count 2
