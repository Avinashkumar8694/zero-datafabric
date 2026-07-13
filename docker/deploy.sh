#!/usr/bin/env bash
# deploy.sh - Simplify deployment and update operations on the VPS for zero-datafabric
set -euo pipefail

echo "====================================================="
echo "Starting Zero Datafabric deployment update on VPS..."
echo "====================================================="

# Ensure .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env file is missing. Please create one before deploying."
  exit 1
fi

echo "1. Pulling latest images from Docker Hub..."
docker compose pull

echo "2. Applying container updates (recreating modified services)..."
docker compose up -d

echo "3. Cleaning up old/dangling docker images to save space..."
docker image prune -f

echo "====================================================="
echo "Deployment successfully updated!"
echo "====================================================="
