#!/bin/bash

# Ensure data directory exists
mkdir -p data/ workers/

# Start the dashboard server in the background (binds to $PORT)
node bin/queuectl.js dashboard &

# Start 2 workers in the background
node bin/queuectl.js worker start --count 2 &

# Start an infinite simulation loop in the foreground to keep the container alive and dashboard busy
echo "Starting live simulation..."
while true; do
  # Enqueue a job that sleeps for a random time (1 to 4 seconds) to create visual activity
  RANDOM_SLEEP=$(( (RANDOM % 4) + 1 ))
  node bin/queuectl.js enqueue "{\"id\":\"sim-$(date +%s)\",\"command\":\"sleep $RANDOM_SLEEP\"}" > /dev/null
  sleep 4
done
